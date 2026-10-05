import SwiftUI

/**
 * 手表主界面：事件列表。
 *
 * watchOS 的交互范式是「信息密度低、靠滚轮翻」——所以这里只做三件事：
 * 顶部一条状态（未读 / 连接情况），中间一列事件卡片，点进去看详情。
 * 刻意不用子页签、不做筛选：表盘就那么大，能一眼看完才是好设计。
 */
struct EventListView: View {

    @EnvironmentObject private var session: WatchSession

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("事件")
                .navigationDestination(for: String.self) { key in
                    if let e = session.events.first(where: { $0.key == key }) {
                        EventDetailView(event: e)
                    } else {
                        Text("这条事件已经不在了").font(.system(size: 13))
                    }
                }
                .toolbar {
                    // 用 .automatic：watchOS 各个版本对 toolbar 位置的默认处理不一样，
                    // 交给系统决定最稳（表盘右上角就那么一小块地方）
                    ToolbarItem {
                        Button {
                            session.requestSync()
                        } label: {
                            if session.syncing {
                                ProgressView()
                            } else {
                                Image(systemName: session.reachable ? "arrow.triangle.2.circlepath" : "wifi.slash")
                            }
                        }
                        .disabled(session.syncing)
                    }
                }
        }
        .onAppear { session.activate() }
    }

    @ViewBuilder
    private var content: some View {
        if session.visible.isEmpty {
            EmptyStateView()
        } else {
            List {
                StatusSection()
                Section {
                    ForEach(session.visible, id: \.key) { event in
                        NavigationLink(value: event.key) {
                            EventRow(event: event)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            if !event.read {
                                Button {
                                    session.markRead(event)
                                } label: {
                                    Label("已读", systemImage: "checkmark")
                                }
                                .tint(.green)
                            }
                        }
                    }
                } header: {
                    HStack(spacing: 4) {
                        Text(session.unread > 0 ? "\(session.unread) 条未读" : "全部已读")
                        Spacer()
                        if session.total > session.visible.count {
                            Text("共 \(session.total) 条")
                        }
                    }
                    .font(.system(size: 12))
                }
            }
        }
    }
}

/// 顶部状态条：连接情况 + 最近一次同步时间 + 一键全部已读
private struct StatusSection: View {
    @EnvironmentObject private var session: WatchSession

    var body: some View {
        Section {
            HStack(spacing: 6) {
                Circle()
                    .fill(session.reachable ? Color.green : (session.connected ? Color.orange : Color.gray))
                    .frame(width: 7, height: 7)
                VStack(alignment: .leading, spacing: 1) {
                    Text(session.reachable ? "手机在线" : session.activation)
                        .font(.system(size: 13, weight: .semibold))
                    if let at = session.lastSyncAt {
                        Text(at, style: .relative)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    } else {
                        Text("等待同步")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if session.unread > 0 {
                    Button {
                        session.markAllRead()
                    } label: {
                        Image(systemName: "checkmark.circle")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.green)
                }
            }
        }
    }
}

/// 单条事件：左侧类型色块图标 + 中间通道与摘要 + 底部相对时间
private struct EventRow: View {
    let event: WatchEvent

    var body: some View {
        HStack(spacing: 8) {
            ZStack {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(accent.opacity(0.22))
                Image(systemName: event.symbol)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(accent)
            }
            .frame(width: 30, height: 30)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    if !event.read {
                        Circle().fill(accent).frame(width: 5, height: 5)
                    }
                    Text(event.name)
                        .font(.system(size: 14, weight: event.read ? .regular : .semibold))
                        .lineLimit(1)
                }
                Text(event.summary)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Text(event.date, style: .relative)
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
    }

    private var accent: Color {
        switch event.type {
        case "offline": return .red
        case "person", "face": return .orange
        case "zone", "count": return .blue
        case "online": return .green
        default: return .yellow
        }
    }
}

/// 空态：没有事件时告诉用户为什么没有、怎么办
private struct EmptyStateView: View {
    @EnvironmentObject private var session: WatchSession

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                Image(systemName: session.reachable ? "tray" : "iphone.slash")
                    .font(.system(size: 28))
                    .foregroundStyle(.secondary)
                Text(session.reachable ? "还没有事件" : "还没连上手机")
                    .font(.system(size: 14, weight: .semibold))
                Text(session.reachable
                     ? "手机上收到报警后会自动同步过来"
                     : "请把 iPhone 放在附近，并打开 BossMonitor")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("立即同步") { session.requestSync() }
                    .font(.system(size: 12))
            }
            .padding(.horizontal, 6)
        }
    }
}
