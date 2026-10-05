import Foundation
import Capacitor
import UIKit
import UserNotifications

/**
 * MonitorExtras —— 本项目自带的轻量原生能力插件
 * ============================================================================
 * 为什么不直接用社区插件（比如 @capacitor-community/keep-awake）？
 *   本工程 iOS 侧用的是 Capacitor 的 SPM 本地包（CapApp-SPM），
 *   装第三方插件要同时改 Package.swift + package.json + cap sync，
 *   而我们需要的能力只有几行 API。自己写一个 plugin 文件，编译进 App target，
 *   Capacitor 会自动发现，零新增依赖、零同步步骤。
 *
 * 前端调用（见 src/composables/useWakeLock.js / useSystemNotify.js）：
 *   window.Capacitor.Plugins.MonitorExtras.setKeepAwake({ enabled: true })
 *   window.Capacitor.Plugins.MonitorExtras.requestNotifyPermission()
 *   window.Capacitor.Plugins.MonitorExtras.notify({ title, body, tag })
 */
@objc(MonitorExtrasPlugin)
public class MonitorExtrasPlugin: CAPPlugin, CAPBridgedPlugin, UNUserNotificationCenterDelegate {

    public let identifier = "MonitorExtrasPlugin"
    public let jsName = "MonitorExtras"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setKeepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getKeepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestNotifyPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "notifyPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "notify", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exitApp", returnType: CAPPluginReturnPromise)
    ]

    /**
     * 插件被 Capacitor bridge 加载时调用（生命周期钩子）。
     *
     * 在这里接管 UNUserNotificationCenter 的 delegate 是**必需**的：
     * iOS 默认在 App 处于前台时**静默丢弃**通知（什么都不显示）。
     * 不实现 willPresent，用户就会遇到"开着 App 反而看不到报警"的怪事 ——
     * 而监控场景恰恰大部分时间都开着 App。
     */
    override public func load() {
        UNUserNotificationCenter.current().delegate = self
    }

    // MARK: - 屏幕常亮

    /**
     * 开关屏幕常亮。
     *
     * ⚠️ 一个必须知道的系统行为：**App 退到后台时，iOS 会强制把
     *    isIdleTimerDisabled 复位**，回到前台不会自动恢复。
     *    所以前端在 Capacitor 的 appStateChange 事件里会重新调用一次本方法，
     *    否则用户切出去看个消息再回来，常亮就悄悄失效了。
     */
    @objc func setKeepAwake(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = enabled
            call.resolve(["enabled": UIApplication.shared.isIdleTimerDisabled])
        }
    }

    /// 查询当前状态（设置面板展示 / 前端自检用）
    @objc func getKeepAwake(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["enabled": UIApplication.shared.isIdleTimerDisabled])
        }
    }

    // MARK: - 系统通知

    /**
     * 申请通知权限（首次会弹系统授权框）。
     * 返回 granted = 用户是否同意；denied 后再调不会再弹框，只会直接返回 false，
     * 所以前端要引导用户去「设置 → 通知」里手动打开。
     */
    @objc func requestNotifyPermission(_ call: CAPPluginCall) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            DispatchQueue.main.async {
                call.resolve(["granted": granted])
            }
        }
    }

    /// 查询当前授权状态：default / granted / denied
    @objc func notifyPermission(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status: String
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral:
                status = "granted"
            case .denied:
                status = "denied"
            default:
                status = "default"
            }
            DispatchQueue.main.async {
                call.resolve(["status": status])
            }
        }
    }

    /**
     * 发一条本地通知。
     * @param title 标题
     * @param body  正文
     * @param tag   业务标识（同 tag 的旧通知会被新通知顶掉，避免刷屏）
     */
    @objc func notify(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? ""
        let body = call.getString("body") ?? ""
        let tag = call.getString("tag") ?? UUID().uuidString

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = call.getBool("silent") == true ? nil : .default

        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 0.1, repeats: false)
        let req = UNNotificationRequest(identifier: tag, content: content, trigger: trigger)
        UNUserNotificationCenter.current().add(req) { error in
            DispatchQueue.main.async {
                if let e = error {
                    call.reject("通知发送失败：" + e.localizedDescription)
                } else {
                    call.resolve()
                }
            }
        }
    }

    // MARK: - 强制终结

    /**
     * 立即结束 App 进程（设置 → 配置方案 →「强制终结 App」）。
     *
     * 用户要求「终结后应用自动退出，不得在后台运行任何任务」——
     * exit(0) 直接杀进程：WKWebView、解码器、WebSocket、推送、常亮锁全部随之消失，
     * 这是唯一能保证后台什么都不剩的办法（iOS 没有"自杀退到后台并结束"这种 API）。
     *
     * Apple 官方不鼓励程序化退出（审核 2.5.4 可能提意见），自用分发包不受限；
     * 真要上架时把这一项换成引导用户上滑关闭即可。
     */
    @objc func exitApp(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            // 退出前把能停的都停掉：杀进程前的零点几秒里不该再响一声通知
            UIApplication.shared.isIdleTimerDisabled = false
            UIApplication.shared.applicationIconBadgeNumber = 0
            UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
            UNUserNotificationCenter.current().removeAllDeliveredNotifications()
            call.resolve()
            exit(0)
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    /** App 在前台时也显示横幅 + 声音（默认行为是静默丢弃，见 load() 注释） */
    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }

    /** 用户点通知 → App 已被系统拉起，这里只负责把画面切回前台（定位逻辑在前端） */
    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        DispatchQueue.main.async {
            // 通知点击后 App 通常已被唤起；再确保窗口 Key & 可见
            let win = UIApplication.shared.connectedScenes
                .compactMap { ($0 as? UIWindowScene)?.keyWindow }
                .first
            win?.makeKeyAndVisible()
            // 把 tag（通知 identifier）回传给前端，用于定位对应画面
            let tag = response.notification.request.identifier
            self.notifyListeners("notifyClick", data: ["tag": tag])
        }
        completionHandler()
    }
}
