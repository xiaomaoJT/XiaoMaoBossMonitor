# 模型目录（本仓库不包含模型文件）

这个目录**故意是空的**。

`src/workers/aiWorker.js` 会从 `/ai/models/` 加载 ONNX 模型来做浏览器端推理。模型文件不随本仓库分发，原因写在下面。

## 需要哪些文件

| 文件名 | 用途 | 输入 | 来源 | 许可证 |
|---|---|---|---|---|
| `yolo11n.onnx` | 人形检测（COCO `person`） | 640×640 | Ultralytics YOLO11 | **AGPL-3.0** |
| `yolo11s.onnx` | 人形检测（更准，更慢） | 640×640 | Ultralytics YOLO11 | **AGPL-3.0** |
| `yolov8n-pose.onnx` | 姿态估计（17 关键点） | 640×640 | Ultralytics YOLOv8-pose | **AGPL-3.0** |
| `scrfd-500m.onnx` | 人脸检测 + 5 点关键点 | 640×640 | InsightFace SCRFD | MIT（权重另需核实） |
| `mobilefacenet.onnx` | 人脸特征（512 维） | 112×112 | InsightFace MobileFaceNet | MIT（权重另需核实） |
| `genderage.onnx` | 性别 / 年龄 | 96×96 | InsightFace genderage | MIT（权重另需核实） |
| `face_attrib_net.onnx` | 口罩 / 眼镜属性 | 96×96 | InsightFace face_attrib_net | MIT（权重另需核实） |
| `face_attrib_net.data` | 上者的外置权重（约 43 MB，必须同目录） | — | 同上 | 同上 |

## 为什么不放在仓库里

人形检测与姿态这两个最核心的模型来自 Ultralytics，其官方声明是：

> *All Ultralytics YOLO trained models fall under the AGPL-3.0 License by default.*

**分发这些权重会触发 AGPL-3.0 的开源义务**，与本仓库的 Apache-2.0 授权不兼容。所以模型不进仓库、不进历史提交，由使用者自行获取。

## 获取方式

1. 安装 Ultralytics 并导出 ONNX（导出脚本请参考其官方文档）：

   ```bash
   pip install ultralytics
   yolo export model=yolo11n.pt format=onnx imgsz=640
   yolo export model=yolo11s.pt format=onnx imgsz=640
   yolo export model=yolov8n-pose.pt format=onnx imgsz=640
   ```

2. InsightFace 系列的四个模型从其 Model Zoo 获取后自行转换为 ONNX。

3. 把全部文件放进本目录（`public/ai/models/`），重新 `npm run build`。

> 请注意：自行获取与使用这些权重，你需要自己遵守其原始许可证。把 YOLO 权重用于商业产品通常需要 Ultralytics 的 Enterprise License。

## 没有模型会怎样

不会报错，只是**浏览器端推理不可用**：

- 大屏实时预览、布局、配置、登录等全部功能正常；
- 「检测识别」里的本地推理会一直停在未就绪状态；
- 界面不会产生告警事件。

如果你已有独立的分析引擎，用它的 HTTP 接口即可获得完整检测能力（设置 → 检测识别 → 后端检测服务），完全不依赖本目录。
