import SwiftUI

/**
 * BossMonitor 的 Apple Watch 端。
 *
 * 为什么手表端是**纯原生 SwiftUI**而不是套一层 WebView：
 *   watchOS 不提供 WKWebView —— 系统里根本没有这个类。
 *   所以手表不能复用手机端那套 Vue 界面，只能重写一个"只看事件"的轻量版本。
 *
 * 职责刻意收窄（用户明确要求）：**只做事件查看**。
 *   能看：事件列表、单条详情（含缩略图）、未读状态、推送结果
 *   能改：标记已读（含一键全部已读）
 *   不做：配置通道、改推送凭据、看实时画面 —— 这些在手表上既难操作，也没必要
 */
@main
struct MonitorWatchApp: App {

    @StateObject private var session = WatchSession.shared

    var body: some Scene {
        WindowGroup {
            EventListView()
                .environmentObject(session)
        }
    }
}
