<!-- Flow 设置页：自 SettingsDrawer.vue 拆出，模板/逻辑零改动；状态·函数·emit 经父级 provide('sd') 注入 -->
<template>
  <section class="block">
    <div class="block-head">
      <h3>人员流向（跨摄像头走向）</h3>
      <span class="state-chip" :class="flowSummary.ok ? 'ready' : (flowSummary.enabled ? 'warn' : '')">{{ flowSummary.text }}</span>
    </div>
    <p class="hint">
      建立在人形轨迹 / 人脸识别之上：当<b>同一个人</b>先在某个区域<b>离场</b>，
      又在时间窗内依次出现在后续区域的<b>入场</b>，就记一次「走向」事件，推送
      「谁从哪去了哪」。支持多跳（A→B→C…）—— 点「加途经点」可串更长。
      默认靠人脸归组名判定身份（几乎零额外算力）；也可放宽到不要求人脸。
      属于轻量离散相遇判定，不是实时轨迹画线。
      <br />
      每个节点的区域既可以圈选，也可以选<b>「画面全区域」</b>（整幅画面的出现 / 离开即进出）。
    </p>
    <p class="hint tight">
      保存流向会自动开启相关摄像头的「区域监测」与相关区域的「进出检测」——
      这是流向的物理前提（流向本质就是检测某人进出这些区域）。你仍可单独在区域规则里关掉
      「走出 / 走入区域」<b>报警</b>，不影响流向；但若手动关掉某个流向节点的「进出检测」，这里会标红「🔴 前提未满足」。
      <br />
      不想圈区域也可以：节点区域选<b>「画面全区域」</b>——不圈选，这一路画面的「有人出现 / 人离开」即进出
      （离开判定依赖轨迹消失，通常有几秒延迟；该选项只服务流向，不会当成走进 / 走出报警，也不计入人员计数）。
    </p>

    <div class="opt col">
      <span>
        <strong>相反流向防抖</strong>
        <em>同一个人短时间内接连走完两条方向相反的流向（如先 A「走入」、几秒后又 B「走出」）时，第二条不再推送 —— 多半是同一次进出的重复触发。选「关闭」则两条都推（老行为）</em>
      </span>
      <SelectField cls="mini" v-model.number="flowOppositeSec" :options="OPT_FLOW_OPPOSITE" />
    </div>

    <div class="flow-head">
      <strong>已配置流向（{{ (opts.flows || []).length }} 条）</strong>
      <button class="btn small primary" @click="addFlow">＋ 新增流向</button>
    </div>

    <p class="hint tight" v-if="!(opts.flows || []).length">
      还没有任何流向。点「新增流向」创建第一条，例如「门口 → 走廊」「电梯厅 → 办公区」。
    </p>

    <div class="flow-card" v-for="(flow, i) in (opts.flows || [])" :key="flow.id || i">
      <div class="flow-card-head">
        <input
          class="field flow-name"
          type="text"
          maxlength="20"
          v-model.trim="flow.name"
          placeholder="流向名称（如：门口→走廊）"
        />
        <label class="switch-wrap" title="启用该流向">
          <span class="switch" :class="{ on: flow.enabled }" @click="flow.enabled = !flow.enabled"></span>
        </label>
        <button class="icon-btn danger" title="删除该流向" @click="removeFlow(i)">🗑</button>
      </div>

      <div class="flow-route">
        <template v-for="(node, ni) in flow.path" :key="ni">
          <div class="flow-end">
            <div class="flow-end-label">
              <span>{{ ni === 0 ? '起点（从）' : (ni === flow.path.length - 1 ? '终点（到）' : '途经') }}</span>
              <button
                v-if="flow.path.length > 2"
                class="icon-btn danger xsm"
                title="删除该节点"
                @click="removeFlowNode(flow, ni)"
              >✕</button>
            </div>
            <SelectField
              cls="mini wide"
              v-model="node.cam"
              :options="camOptions"
              :placeholder="`第 ${ni + 1} 个节点摄像头`"
              @change="node.zone = ''"
            />
            <SelectField
              cls="mini wide"
              v-model="node.zone"
              :options="zoneOptions(node.cam)"
              :placeholder="`第 ${ni + 1} 个节点区域`"
            />
            <p class="hint tight" v-if="node.cam && !camHasZones(node.cam)">
              该摄像头还没有圈选区域。可以直接选<b>「画面全区域」</b>（整幅画面的出现 / 离开即进出，无需圈选）；
              要更精细的节点，请到对应画面的「更多操作 → 进出 / 徘徊区域」（图标 ▤）拖拽圈选，不是「圈选检测区域」（图标 ▢）。
            </p>
          </div>
          <div v-if="ni < flow.path.length - 1" class="flow-arrow">→</div>
        </template>
        <button
          v-if="flow.path.length < FLOW_MAX_NODES"
          class="btn small ghost"
          title="在末尾加一个途经点（支持 A→B→C 多跳走向）"
          @click="addFlowNode(flow)"
        >＋ 加途经点</button>
      </div>

      <div class="opt col">
        <span>
          <strong>匹配时间窗</strong>
          <em>出场后多久内入场才算同一次走向</em>
        </span>
        <SelectField cls="mini" v-model.number="flow.windowSec" :options="OPT_FLOW_WINDOW" />
      </div>

      <label class="opt">
        <span>
          <strong>要求人脸身份</strong>
          <em>开启：必须识别到人脸才匹配；关闭：匿名兜底——没识别到人脸时按「同一时刻一条匿名链路」匹配，一个人走完整条路径即有效，多人同窗并行可能串链</em>
        </span>
        <span class="switch" :class="{ on: flow.requireFace }" @click="flow.requireFace = !flow.requireFace"></span>
      </label>

      <label class="opt">
        <span>
          <strong>推送该流向</strong>
          <em>关闭则只记录不推送</em>
        </span>
        <span class="switch" :class="{ on: flow.push }" @click="flow.push = !flow.push"></span>
      </label>

      <label class="opt">
        <span>
          <strong>作为关键事件实时推送</strong>
          <em>开启：一旦匹配立刻单发（静默时段也推）；关闭：走普通推送 / 日常汇总</em>
        </span>
        <span class="switch" :class="{ on: flow.asCritical }" @click="flow.asCritical = !flow.asCritical"></span>
      </label>

      <p class="flow-errors" v-if="flowStateOf(flow).errors.length || flowStateOf(flow).prereq.issues.length">
        <span class="flow-err" v-for="(e, k) in flowStateOf(flow).errors" :key="'e' + k">⚠ {{ e }}</span>
        <span class="flow-err prereq" v-for="(p, k) in flowStateOf(flow).prereq.issues" :key="'p' + k">🔴 {{ p.text }}</span>
      </p>
      <p class="flow-ok" v-else-if="flow.enabled && flowStateOf(flow).prereq.met">✓ 配置有效，已生效</p>
    </div>
  </section>
</template>

<script setup>
import { inject } from 'vue'

/* 设置抽屉上下文（父级 SettingsDrawer 用 provide('sd', …) 暴露全部状态 / 函数 / emit / props） */
const sd = inject('sd')
const { FLOW_MAX_NODES, OPT_FLOW_WINDOW, OPT_FLOW_OPPOSITE, SelectField, addFlow, addFlowNode, camHasZones, camOptions, emit, flowOppositeSec, flowStateOf, flowSummary, opts, props, removeFlow, removeFlowNode, zoneOptions } = sd
const { cameras, options, hiddenIds, layouts, layoutKey, native, events, openTab, tempSilent } = props
</script>
