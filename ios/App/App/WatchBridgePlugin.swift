import Foundation
import Capacitor
import WatchConnectivity
import UIKit

/**
 * WatchBridge —— 手机 ↔ Apple Watch 的事件同步桥
 * ============================================================================
 * watchOS 上跑不了 WKWebView（系统根本不提供），所以手表端只能是原生 SwiftUI。
 * 这一层负责把 web 层已经算好的「事件」（报警记录）搬到手表上：
 *
 *   手机 → 手表
 *     · syncEvents()  web 层每次事件变化后推一份**最新快照**（最多 30 条）
 *     · 通道用 updateApplicationContext（覆盖式，手表随时能取到最新状态）
 *       + sendMessage（手表正在前台时立刻到），两者都失败就退化成 transferUserInfo
 *   手表 → 手机
 *     · markRead   手表上点「标记已读」→ 这里改写缓存快照 + notifyListeners 回 web
 *     · requestSync 手表启动/回前台主动要一次数据 → **原生直接回**，不用等 web 层
 *
 * 为什么快照要在原生侧缓存一份（UserDefaults）：
 *   手表来要数据时，手机 App 可能已经被切到后台甚至被强杀 —— 那时 JS 是死的，
 *   没法响应。缓存住最后一份快照，手表至少还能看到"最后一次同步的状态"。
 *
 * 前端调用（见 src/composables/useWatchBridge.js）：
 *   window.Capacitor.Plugins.WatchBridge.status()
 *   window.Capacitor.Plugins.WatchBridge.syncEvents({ events })
 *   window.Capacitor.Plugins.WatchBridge.clear()
 *   window.Capacitor.Plugins.WatchBridge.addListener('watchCommand', cb)
 */
@objc(WatchBridgePlugin)
public class WatchBridgePlugin: CAPPlugin, CAPBridgedPlugin, WCSessionDelegate {

    public let identifier = "WatchBridgePlugin"
    public let jsName = "WatchBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "syncEvents", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)
    ]

    /// 手表端事件列表的保留上限（快照越小，同步越快、越不容易被系统丢）
    private let maxEvents = 30
    /// 只有最新的这几条带缩略图 —— 整份快照塞满 base64 图会撑爆 payload
    private let thumbLimit = 6

    private static let cacheKey = "monitor-wall-watch-payload"
    private var session: WCSession? { WCSession.isSupported() ? WCSession.default : nil }
    private var lastPayload: [String: Any]? {
        didSet {
            guard let p = lastPayload else {
                UserDefaults.standard.removeObject(forKey: Self.cacheKey)
                return
            }
            UserDefaults.standard.set(try? JSONSerialization.data(withJSONObject: p), forKey: Self.cacheKey)
        }
    }

    // MARK: - 生命周期

    override public func load() {
        if let cached = UserDefaults.standard.data(forKey: Self.cacheKey),
           let obj = try? JSONSerialization.jsonObject(with: cached) as? [String: Any] {
            lastPayload = obj
        }
        guard let s = session else { return }
        s.delegate = self
        s.activate()
    }

    // MARK: - 对外方法

    /// 当前配对 / 安装 / 可达状态。设置页用它决定显示什么文案。
    @objc func status(_ call: CAPPluginCall) {
        guard let s = session else {
            call.resolve([
                "supported": false, "activated": false,
                "paired": false, "installed": false, "reachable": false,
                "hasCache": lastPayload != nil
            ])
            return
        }
        call.resolve([
            "supported": true,
            "activated": s.activationState == .activated,
            "paired": s.isPaired,
            "installed": s.isWatchAppInstalled,
            "reachable": s.isReachable,
            "hasCache": lastPayload != nil
        ])
    }

    /**
     * 推一份事件快照给手表。
     * @param events 由前端裁剪好的轻量事件数组（见 useWatchBridge.toWatchEvent）
     * @param reason 可选，仅用于日志/调试（'append' | 'read' | 'reset' | 'manual'）
     */
    @objc func syncEvents(_ call: CAPPluginCall) {
        let raw = call.getArray("events") ?? []
        let list = raw.compactMap { $0 as? [String: Any] }
        let reason = call.getString("reason") ?? "sync"

        let trimmed = Array(list.prefix(maxEvents))
        var out: [[String: Any]] = []
        for (i, e) in trimmed.enumerated() {
            var item = e
            /*
             * 缩略图是整份 payload 里最大的一块（一张 360px 的 JPEG base64 约 8~15KB）。
             * 只给最新几条带上：手表首屏能看图，往下翻是文字 —— 比整份同步失败强得多。
             */
            if i >= thumbLimit { item.removeValue(forKey: "thumb") }
            out.append(item)
        }

        let payload: [String: Any] = [
            "type": "events",
            "at": Date().timeIntervalSince1970 * 1000,
            "total": list.count,
            "unread": trimmed.filter { ($0["read"] as? Bool) != true }.count,
            "events": out,
            "reason": reason
        ]
        lastPayload = payload
        deliver(payload, reply: call)
    }

    /// 清空手表上的事件（恢复初始化 / 清空报警记录时调用）
    @objc func clear(_ call: CAPPluginCall) {
        let payload: [String: Any] = [
            "type": "clear",
            "at": Date().timeIntervalSince1970 * 1000,
            "events": [],
            "total": 0,
            "unread": 0
        ]
        lastPayload = payload
        deliver(payload, reply: call)
    }

    // MARK: - 下发

    /** 三条通道依次降级：能立刻到就立刻到，不行就排队，再不行至少把上下文留下 */
    private func deliver(_ payload: [String: Any], reply: CAPPluginCall?) {
        guard let s = session, s.activationState == .activated else {
            reply?.resolve(["ok": false, "reason": "session-not-activated", "cached": true])
            return
        }

        do {
            try s.updateApplicationContext(payload)
        } catch {
            // 覆盖式通道失败不致命：还有下面两条
        }

        if s.isReachable {
            s.sendMessage(payload, replyHandler: { _ in
                reply?.resolve(["ok": true, "via": "message"])
            }, errorHandler: { _ in
                // 手表 App 没在前台：退化成可靠的后台队列
                s.transferUserInfo(payload)
                reply?.resolve(["ok": true, "via": "userInfo"])
            })
        } else {
            s.transferUserInfo(payload)
            reply?.resolve(["ok": true, "via": "userInfo+context"])
        }
    }

    // MARK: - 手表指令

    private func handle(_ message: [String: Any], replyHandler: (([String: Any]) -> Void)? = nil) {
        let cmd = message["cmd"] as? String ?? ""

        switch cmd {
        case "markRead":
            let key = message["key"] as? String ?? ""
            let read = message["read"] as? Bool ?? true
            markCached(key: key, read: read)
            notifyListeners("watchCommand", data: ["cmd": "markRead", "key": key, "read": read])
            replyHandler?(["ok": true])

        case "requestSync":
            /*
             * 手表要数据时不绕道 JS —— 手机 App 在后台时 JS 是暂停的，
             * 绕道意味着"我抬起手腕，转圈等到超时"。有缓存就直接回缓存。
             */
            if let p = lastPayload, let s = session, s.activationState == .activated {
                do { try s.updateApplicationContext(p) } catch { }
                if s.isReachable { s.sendMessage(p, replyHandler: nil, errorHandler: nil) }
                replyHandler?(["ok": true, "cached": true])
            } else {
                replyHandler?(["ok": false, "reason": "no-cache"])
                // 让前台 JS 补一份（顺带把状态页刷新）
                notifyListeners("watchCommand", data: ["cmd": "requestSync"])
            }

        default:
            replyHandler?(["ok": false])
        }
    }

    /// 把手表上的「已读」落回缓存快照，保证下次推送不会把已读又变回未读。
    /// key == "*" 表示「全部已读」（手表上那个一键按钮）。
    private func markCached(key: String, read: Bool) {
        guard var p = lastPayload, var list = p["events"] as? [[String: Any]] else { return }
        let all = key == "*"
        var hit = false
        for i in list.indices where all || (list[i]["key"] as? String) == key {
            list[i]["read"] = read
            hit = true
        }
        guard hit else { return }
        p["events"] = list
        p["unread"] = list.filter { ($0["read"] as? Bool) != true }.count
        lastPayload = p
    }

    // MARK: - WCSessionDelegate

    public func session(_ session: WCSession,
                        activationDidCompleteWith activationState: WCSessionActivationState,
                        error: Error?) {
        if activationState == .activated, let p = lastPayload {
            // 激活后补推一次，覆盖"上次没收到的快照"
            try? session.updateApplicationContext(p)
        }
    }

    public func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        handle(message)
    }

    public func session(_ session: WCSession,
                        didReceiveMessage message: [String: Any],
                        replyHandler: @escaping ([String: Any]) -> Void) {
        handle(message, replyHandler: replyHandler)
    }

    public func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        handle(userInfo)
    }

    /// 手表上装了/卸了 App、配对状态变了 —— 通知前端刷新设置页
    public func sessionWatchStateDidChange(_ session: WCSession) {
        notifyListeners("watchState", data: [
            "paired": session.isPaired,
            "installed": session.isWatchAppInstalled,
            "reachable": session.isReachable
        ])
    }

    public func sessionReachabilityDidChange(_ session: WCSession) {
        notifyListeners("watchState", data: [
            "paired": session.isPaired,
            "installed": session.isWatchAppInstalled,
            "reachable": session.isReachable
        ])
    }

    // iOS 专属：切换手表时系统要求重新激活
    public func sessionDidBecomeInactive(_ session: WCSession) {}

    public func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }
}
