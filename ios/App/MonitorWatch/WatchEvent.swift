import Foundation

/**
 * 手表端的一条事件（报警记录）。
 *
 * 它是手机侧记录的**子集**：索引库里的原图（shot）、流地址、ROI、检测区域、
 * 功能快照这些都留在手机上 —— 手表屏幕小、带宽窄，真正要看的只有
 * 「什么时间、哪一路、发生了什么、严不严重、有没有推出去」。
 */
struct WatchEvent: Codable, Hashable {

    /// 与手机端记录同 key，标记已读时要靠它回写
    let key: String
    /// 通道 id（cam-1 …）
    let id: String
    /// 通道名，例如「大门外」
    let name: String
    /// motion / person / face / pose / zone / count / offline / online
    let type: String
    /// 毫秒时间戳
    let time: Double
    /// 一行摘要（手机端 alarmBrief 生成）
    let brief: String
    /// 系统事件的正文（离线/恢复时才有）
    let text: String
    /// 画面变动幅度 0~1
    let ratio: Double?
    /// 小缩略图 dataURL（只有最新的几条会带，其余为空）
    let thumb: String
    /// 已读 / 未读
    var read: Bool
    /// 推送状态：'' | 'sending' | 'ok' | 'fail' | 'off'
    let push: String
    let pushError: String
    let pushChannels: String

    var date: Date { Date(timeIntervalSince1970: time / 1000) }

    enum CodingKeys: String, CodingKey {
        case key, id, name, type, time, brief, text, ratio, thumb, read, push, pushError, pushChannels
    }

    init(from dict: [String: Any]) {
        key = dict["key"] as? String ?? UUID().uuidString
        id = dict["id"] as? String ?? ""
        name = dict["name"] as? String ?? "未知通道"
        type = dict["type"] as? String ?? "motion"
        time = (dict["time"] as? Double) ?? Double(dict["time"] as? Int ?? 0)
        brief = dict["brief"] as? String ?? ""
        text = dict["text"] as? String ?? ""
        ratio = dict["ratio"] as? Double
        thumb = dict["thumb"] as? String ?? ""
        read = (dict["read"] as? Bool) ?? false
        push = dict["push"] as? String ?? ""
        pushError = dict["pushError"] as? String ?? ""
        pushChannels = dict["pushChannels"] as? String ?? ""
    }

    // MARK: - 展示辅助

    /// 事件类型 → 图标（SF Symbols）
    var symbol: String {
        switch type {
        case "person": return "figure.walk"
        case "face": return "face.smiling"
        case "pose": return "figure.arms.open"
        case "zone": return "arrow.left.arrow.right"
        case "count": return "number"
        case "offline": return "exclamationmark.triangle.fill"
        case "online": return "checkmark.circle.fill"
        default: return "arrow.up.and.down.and.arrow.left.and.right"
        }
    }

    /// 事件类型 → 中文短名
    var typeLabel: String {
        switch type {
        case "person": return "人形"
        case "face": return "人脸"
        case "pose": return "姿态"
        case "zone": return "区域"
        case "count": return "计数"
        case "offline": return "离线"
        case "online": return "恢复"
        default: return "移动"
        }
    }

    /// 严重度：离线 / 人形 / 区域 用醒目的红，其余用暖色
    var isSerious: Bool {
        ["offline", "person", "zone", "face"].contains(type)
    }

    /// 正文摘要：优先用 alarmBrief 的结果，系统事件退回 text
    var summary: String {
        if !brief.isEmpty { return brief }
        if !text.isEmpty { return text }
        if let r = ratio, r > 0 { return "变动 \(String(format: "%.1f", r * 100))%" }
        return typeLabel
    }

    var pushLabel: String {
        switch push {
        case "ok": return "已推送"
        case "sending": return "推送中"
        case "fail": return "推送失败"
        case "off": return "未推送"
        default: return "未推送"
        }
    }

    /// 同一条记录的内容指纹 —— 用来判断同步过来的快照是不是真的变了，
    /// 没变就不刷新列表（手表上每次刷新都有肉眼可见的闪动）
    var fingerprint: String {
        "\(key)|\(read)|\(push)|\(pushError)|\(brief)|\(!thumb.isEmpty)"
    }
}

/// 手机侧下发的整份快照
struct WatchPayload: Codable {
    var at: Double
    var total: Int
    var unread: Int
    var events: [WatchEvent]

    static let empty = WatchPayload(at: 0, total: 0, unread: 0, events: [])
}
