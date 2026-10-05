import Foundation
import WatchConnectivity
import SwiftUI

/**
 * 手表端的会话 + 本地状态。
 *
 * 设计取舍：
 *  1. **快照本地留一份**（UserDefaults）：抬腕就能看到上次同步的内容，
 *     不用先转圈等手机 —— 手表最不能忍的就是"打开是空白"。
 *  2. 三条接收通道全都接上（applicationContext / message / userInfo），
 *     手机那边会按可达性自己挑一条，这边不关心它走的哪条。
 *  3. 只有内容指纹变了才刷新 @Published，避免整列表无谓重绘。
 */
@MainActor
final class WatchSession: NSObject, ObservableObject {

    static let shared = WatchSession()

    @Published private(set) var events: [WatchEvent] = []
    @Published private(set) var lastSyncAt: Date?
    @Published private(set) var unread = 0
    /// 手机端这一轮保留的总条数（可能多于手表展示的 30 条）
    @Published private(set) var total = 0
    @Published private(set) var reachable = false
    @Published private(set) var activation = "正在连接…"
    @Published private(set) var syncing = false

    private static let cacheKey = "monitor-wall-watch-cache"
    private var lastFingerprint = ""

    private var session: WCSession? { WCSession.isSupported() ? WCSession.default : nil }

    var connected: Bool { activation == "已连接" }

    // MARK: - 生命周期

    func activate() {
        guard let s = session else {
            activation = "此设备不支持"
            return
        }
        loadCache()
        s.delegate = self
        s.activate()
    }

    /// 手表端只展示最新这些条 —— 屏幕就那么点，30 条已经够翻很久了
    var visible: [WatchEvent] { Array(events.prefix(30)) }

    // MARK: - 缓存

    private func loadCache() {
        guard let data = UserDefaults.standard.data(forKey: Self.cacheKey),
              let payload = try? JSONDecoder().decode(WatchPayload.self, from: data) else { return }
        apply(payload)
    }

    private func saveCache(_ payload: WatchPayload) {
        guard let data = try? JSONEncoder().encode(payload) else { return }
        UserDefaults.standard.set(data, forKey: Self.cacheKey)
    }

    // MARK: - 写入状态

    func apply(_ payload: WatchPayload) {
        let fp = payload.events.map(\.fingerprint).joined(separator: "#")
        let changed = fp != lastFingerprint
        lastFingerprint = fp
        if changed || events.isEmpty {
            events = payload.events
        }
        unread = payload.unread
        total = payload.total
        if payload.at > 0 { lastSyncAt = Date(timeIntervalSince1970: payload.at / 1000) }
        syncing = false
    }

    func clearAll() {
        lastFingerprint = ""
        events = []
        unread = 0
        total = 0
        lastSyncAt = Date()
    }

    // MARK: - 发给手机

    /// 在手表上标记已读：**先本地生效**，再告诉手机。
    /// 先本地的理由是手表到手机有上百毫秒的往返，等回来再变色会有明显迟滞感。
    func markRead(_ event: WatchEvent, read: Bool = true) {
        guard let i = events.firstIndex(where: { $0.key == event.key }) else { return }
        events[i].read = read
        unread = events.filter { !$0.read }.count
        lastFingerprint = events.map(\.fingerprint).joined(separator: "#")
        send(["cmd": "markRead", "key": event.key, "read": read])
    }

    func markAllRead() {
        guard unread > 0 else { return }
        for i in events.indices { events[i].read = true }
        unread = 0
        lastFingerprint = events.map(\.fingerprint).joined(separator: "#")
        send(["cmd": "markRead", "key": "*", "read": true])
    }

    /// 主动要一份最新数据
    func requestSync() {
        syncing = true
        send(["cmd": "requestSync"])
        // 手机没回应时别一直转圈
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            await MainActor.run { self?.syncing = false }
        }
    }

    private func send(_ message: [String: Any]) {
        guard let s = session, s.activationState == .activated else { return }
        if s.isReachable {
            s.sendMessage(message, replyHandler: nil) { _ in
                // 手机 App 不在前台：退回后台队列，等它有空再处理
                s.transferUserInfo(message)
            }
        } else {
            s.transferUserInfo(message)
        }
    }

    // MARK: - 接收

    nonisolated private func decode(_ dict: [String: Any]) -> WatchPayload? {
        let type = dict["type"] as? String ?? "events"
        if type == "clear" { return WatchPayload.empty }
        guard let raw = dict["events"] as? [[String: Any]] else { return nil }
        let list = raw.map { WatchEvent(from: $0) }
        return WatchPayload(
            at: (dict["at"] as? Double) ?? Date().timeIntervalSince1970 * 1000,
            total: (dict["total"] as? Int) ?? list.count,
            unread: (dict["unread"] as? Int) ?? list.filter { !$0.read }.count,
            events: list
        )
    }

    nonisolated private func ingest(_ dict: [String: Any]) {
        guard let payload = decode(dict) else { return }
        Task { @MainActor in
            if dict["type"] as? String == "clear" {
                self.clearAll()
            } else {
                self.apply(payload)
            }
            self.saveCache(payload)
            self.activation = "已连接"
        }
    }
}

// MARK: - WCSessionDelegate

extension WatchSession: WCSessionDelegate {

    nonisolated func session(_ session: WCSession,
                             activationDidCompleteWith activationState: WCSessionActivationState,
                             error: Error?) {
        let reachable = session.isReachable
        let ok = activationState == .activated
        Task { @MainActor in
            self.reachable = reachable
            self.activation = ok ? "已连接" : (error == nil ? "未激活" : "连接失败")
            // 激活后立刻要一次：手机会用缓存直接回，不依赖手机上的 JS 是否还活着
            if ok { self.requestSync() }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        ingest(applicationContext)
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        ingest(message)
    }

    nonisolated func session(_ session: WCSession,
                             didReceiveMessage message: [String: Any],
                             replyHandler: @escaping ([String: Any]) -> Void) {
        ingest(message)
        replyHandler(["ok": true])
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        ingest(userInfo)
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        let reachable = session.isReachable
        Task { @MainActor in
            self.reachable = reachable
            if reachable { self.requestSync() }
        }
    }
}
