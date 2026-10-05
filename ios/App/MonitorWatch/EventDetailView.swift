import SwiftUI
import UIKit

/**
 * 事件详情。
 *
 * 手表上看详情的取舍：
 *   · 缩略图**放在最上面**——报警这件事，"画面里有什么"比文字更先被理解；
 *     手机端只给最新几条带图，没图时这块自动收掉，不会留一个灰框。
 *   · 标签用「通道 · 类型」两行，避免窄屏横向挤压换行。
 *   · 底部两个动作：标记已读 / 重新同步。不做删除——删除是很重的操作，
 *     手表上误触代价太大，真要删回手机上删。
 */
struct EventDetailView: View {

    let event: WatchEvent
    @EnvironmentObject private var session: WatchSession
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {

                if let image = thumbnail {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(maxWidth: .infinity)
                        .frame(height: 92)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }

                header
                summaryBlock

                if !event.pushLabel.isEmpty {
                    infoRow("推送", event.pushLabel, tone: pushTone)
                }
                if !event.pushChannels.isEmpty {
                    infoRow("渠道", event.pushChannels, tone: .secondary)
                }
                if !event.pushError.isEmpty {
                    Text(event.pushError)
                        .font(.system(size: 11))
                        .foregroundStyle(.red)
                        .lineLimit(4)
                }

                actions
            }
            .padding(.horizontal, 4)
            .padding(.bottom, 6)
        }
        .navigationTitle(event.name)
    }

    // MARK: - 片段

    private var header: some View {
        HStack(spacing: 8) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(tone.opacity(0.22))
                Image(systemName: event.symbol)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(tone)
            }
            .frame(width: 34, height: 34)

            VStack(alignment: .leading, spacing: 1) {
                Text(event.typeLabel)
                    .font(.system(size: 15, weight: .semibold))
                Text(event.date.formatted(date: .omitted, time: .shortened))
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if event.read {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 14))
                    .foregroundStyle(.green)
            } else {
                Text("未读")
                    .font(.system(size: 11, weight: .semibold))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(tone.opacity(0.22), in: Capsule())
                    .foregroundStyle(tone)
            }
        }
    }

    private var summaryBlock: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(event.summary)
                .font(.system(size: 13))
                .fixedSize(horizontal: false, vertical: true)
            if !event.text.isEmpty && event.text != event.summary {
                Text(event.text)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let r = event.ratio, r > 0 {
                Text("变动幅度 \(String(format: "%.1f", r * 100))%")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var actions: some View {
        VStack(spacing: 6) {
            if !event.read {
                Button {
                    session.markRead(event)
                    dismiss()
                } label: {
                    Label("标记已读", systemImage: "checkmark.circle")
                        .font(.system(size: 13))
                }
                .buttonStyle(.borderedProminent)
                .tint(.green)
            }
            Button {
                session.requestSync()
            } label: {
                Label(session.syncing ? "同步中…" : "重新同步", systemImage: "arrow.triangle.2.circlepath")
                    .font(.system(size: 13))
            }
            .disabled(session.syncing)
        }
        .padding(.top, 2)
    }

    private func infoRow(_ label: String, _ value: String, tone: Color) -> some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(tone)
            Spacer(minLength: 0)
        }
    }

    // MARK: - 计算属性

    /// 缩略图是 dataURL（`data:image/jpeg;base64,....`），这里解成 UIImage
    private var thumbnail: UIImage? {
        guard !event.thumb.isEmpty,
              let comma = event.thumb.firstIndex(of: ",") else { return nil }
        let b64 = String(event.thumb[event.thumb.index(after: comma)...])
        guard let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else { return nil }
        return UIImage(data: data)
    }

    private var tone: Color {
        switch event.type {
        case "offline": return .red
        case "person", "face": return .orange
        case "zone", "count": return .blue
        case "online": return .green
        default: return .yellow
        }
    }

    private var pushTone: Color {
        switch event.push {
        case "ok": return .green
        case "fail": return .red
        case "sending": return .orange
        default: return .secondary
        }
    }
}
