<!--
  JSON 配置页（v2.2 新增，见使用手册 §5.106）
  ----------------------------------------------------------------------------
  「配置方案」的表单改不到/不想逐页找的字段，这里以 **JSON 文本** 直接查看与编辑：
    · 显示：当前配置的导出形状（cameras + options + hiddenIds，与导出的 .json 完全同构）
    · 编辑：直接改文本；格式化 / 搜索 / 替换 / 复制 常用操作齐备
    · 保存应用：走与「载入配置文件」**同一条** parseConfigFile → applyParsedConfig 链路
      （宽松读取 + 严格归一化），不认识的多余键会被丢弃，缺的补默认 —— 不会把配置改脏
  ⚠️ 文本里含推送凭据（webhook / token / secret），别截图外传。
  改完要点右下角「保存并应用」才写入；这里只是抽屉局部副本的另一扇门。
-->
<template>
  <section class="block">
    <div class="block-head">
      <h3>JSON 配置</h3>
      <span class="head-chips">
        <span class="state-chip" :class="jsonOk ? 'ready' : 'danger'">{{ jsonOk ? 'JSON 合法' : 'JSON 有误' }}</span>
      </span>
    </div>
    <p class="hint">
      以 JSON 直接查看与编辑整份配置（通道 + 全部设置项）。改完点下方<b>「保存并应用」</b>：
      会按「载入配置文件」的同一条归一化链路校验合并，不认识的键丢弃、缺的补默认。
      文本里<b>含推送凭据</b>，别外传。与各表单页共用一份局部副本 —— 两边改动互相可见。
    </p>

    <!-- 工具栏：格式化 / 复制 / 重新载入 -->
    <div class="json-toolbar">
      <button class="btn tiny" @click="formatJson" :disabled="!jsonOk">格式化</button>
      <button class="btn tiny" @click="copyAll">复制</button>
      <button class="btn tiny" @click="reload">重新载入当前配置</button>
      <span class="muted json-meta">{{ lineCount }} 行 · {{ text.length }} 字符</span>
    </div>

    <!-- 搜索 / 替换 -->
    <div class="json-find">
      <input
        class="field mini"
        type="text"
        v-model="findStr"
        placeholder="搜索…"
        @keydown.enter.prevent="findNext(1)"
      />
      <button class="btn tiny" :disabled="!findStr" @click="findNext(1)">下一个</button>
      <button class="btn tiny" :disabled="!findStr" @click="findNext(-1)">上一个</button>
      <span class="muted" v-if="findStr">{{ findCount }} 处</span>

      <input
        class="field mini"
        type="text"
        v-model="replaceStr"
        placeholder="替换为…"
        @keydown.enter.prevent="replaceOne"
      />
      <button class="btn tiny" :disabled="!findStr" @click="replaceOne">替换</button>
      <button class="btn tiny" :disabled="!findStr || !findCount" @click="replaceAll">全部替换</button>
    </div>

    <!-- 编辑区：行号槽 + 文本域，滚动同步 -->
    <div class="json-editor">
      <div class="json-gutter" ref="gutterEl" aria-hidden="true">
        <div v-for="n in lineCount" :key="n" class="json-ln">{{ n }}</div>
      </div>
      <textarea
        ref="taEl"
        class="json-ta"
        v-model="text"
        spellcheck="false"
        wrap="off"
        @scroll="onScroll"
      ></textarea>
    </div>

    <!-- 校验状态 -->
    <p class="json-status" :class="jsonOk ? 'ok' : 'err'">
      <template v-if="jsonOk">JSON 合法{{ camCount !== null ? ` · ${camCount} 路通道` : '' }}</template>
      <template v-else>{{ jsonError }}</template>
    </p>

    <div class="test-row json-save">
      <button class="btn small primary" :disabled="!jsonOk" @click="saveApply">保存并应用</button>
      <span class="muted">按「载入配置文件」的同一条链路归一化后填入抽屉；再点右下角「保存并应用」才真正落盘</span>
    </div>
  </section>
</template>

<script setup>
import { inject, ref, computed, onMounted } from 'vue'

const sd = inject('sd')
const { alertDialog, applyParsedConfig, cams, opts, hidden, parseConfigFile } = sd

const text = ref('')
const taEl = ref(null)
const gutterEl = ref(null)
const findStr = ref('')
const replaceStr = ref('')

/** 生成当前配置的 JSON 文本（与「导出配置文件」同一形状） */
function buildText() {
  return JSON.stringify(
    {
      version: 1,
      exportedAt: new Date().toISOString(),
      cameras: cams.value,
      options: { ...opts },
      hiddenIds: hidden.value
    },
    null,
    2
  )
}

onMounted(() => {
  text.value = buildText()
})

/** 重新载入：丢弃未应用的编辑，回到当前局部副本 */
function reload() {
  text.value = buildText()
  findStr.value = ''
}

const lineCount = computed(() => text.value.split('\n').length)

/* 校验：每次输入都跑一遍 JSON.parse（配置量级几十 KB，开销可忽略）。
 * 错误信息取浏览器原话的行/列 —— 比"解析失败"有用得多。 */
const jsonError = computed(() => {
  try {
    JSON.parse(text.value)
    return ''
  } catch (e) {
    return String((e && e.message) || e)
  }
})
const jsonOk = computed(() => !jsonError.value)
/** 顶层 cameras 数组长度（合法时才显示，给个一眼的规模感） */
const camCount = computed(() => {
  if (!jsonOk.value) return null
  try {
    const d = JSON.parse(text.value)
    return Array.isArray(d && d.cameras) ? d.cameras.length : null
  } catch (_) {
    return null
  }
})

function formatJson() {
  if (!jsonOk.value) return
  try {
    text.value = JSON.stringify(JSON.parse(text.value), null, 2)
  } catch (_) {
    /* jsonOk 已挡住，这里到不了 */
  }
}

function copyAll() {
  const el = taEl.value
  if (el) {
    el.focus()
    el.select()
  }
  const done = () =>
    alertDialog({ title: '已复制', message: '配置 JSON 已复制到剪贴板（含凭据，注意保管）。', variant: 'ok' })
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text.value).then(done, () => document.execCommand('copy') && done())
  } else {
    document.execCommand('copy')
    done()
  }
}

/* ---------------- 搜索 / 替换 ---------------- */
const findCount = computed(() => {
  const q = findStr.value
  if (!q || !text.value) return 0
  let n = 0
  let i = text.value.indexOf(q)
  while (i >= 0) {
    n += 1
    i = text.value.indexOf(q, i + q.length)
  }
  return n
})

/** 选中第 pos 处匹配（滚动到可见范围） */
function selectAt(pos, len) {
  const el = taEl.value
  if (!el) return
  el.focus()
  el.setSelectionRange(pos, pos + len)
  // 粗略把选中行滚进视野：按文本前缀的换行数估行高
  const line = text.value.slice(0, pos).split('\n').length
  const lineH = 18
  el.scrollTop = Math.max(0, (line - 3) * lineH)
  el.selectionStart = pos
  el.selectionEnd = pos + len
}

/** 从当前光标往后（dir=1）或往前（dir=-1）找下一处，到头回绕 */
function findNext(dir) {
  const q = findStr.value
  const el = taEl.value
  if (!q || !el) return
  const t = text.value
  let pos
  if (dir > 0) {
    pos = t.indexOf(q, el.selectionEnd)
    if (pos < 0) pos = t.indexOf(q)
  } else {
    pos = t.lastIndexOf(q, Math.max(0, el.selectionStart - 1))
    if (pos < 0) pos = t.lastIndexOf(q)
  }
  if (pos >= 0) selectAt(pos, q.length)
}

/** 替换当前选中（若它正好是匹配），并跳到下一处 */
function replaceOne() {
  const q = findStr.value
  const el = taEl.value
  if (!q || !el) return
  const sel = text.value.slice(el.selectionStart, el.selectionEnd)
  if (sel === q) {
    const head = text.value.slice(0, el.selectionStart)
    const tail = text.value.slice(el.selectionEnd)
    text.value = head + replaceStr.value + tail
    // Vue 异步刷 textarea 的 value，下一帧再跳下一个
    requestAnimationFrame(() => findNext(1))
  } else {
    findNext(1)
  }
}

function replaceAll() {
  const q = findStr.value
  if (!q) return
  const n = findCount.value
  if (!n) return
  text.value = text.value.split(q).join(replaceStr.value)
}

function onScroll() {
  if (gutterEl.value && taEl.value) gutterEl.value.scrollTop = taEl.value.scrollTop
}

/* ---------------- 保存并应用 ----------------
 * 与「载入配置文件」「导入配置」同一条链路：parseConfigFile（宽松读取 + 严格归一化）
 * → applyParsedConfig（填进抽屉局部副本）。解析失败原样报错，绝不半推半就。 */
function saveApply() {
  const parsed = parseConfigFile(text.value)
  if (!parsed.ok) {
    alertDialog({ title: '无法应用', message: parsed.error, variant: 'danger' })
    return
  }
  const cfg = applyParsedConfig(parsed)
  text.value = buildText()
  alertDialog({
    title: '已应用',
    message: `JSON 已按归一化链路填入（${cfg.cameras.length} 路通道）。点抽屉右下角「保存并应用」后真正生效。`,
    variant: 'ok'
  })
}
</script>

<style scoped>
.json-toolbar,
.json-find {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  margin: 6px 0;
}
.json-meta {
  margin-left: auto;
  font-size: 11px;
}
.json-editor {
  display: flex;
  height: 380px;
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  overflow: hidden;
  background: var(--panel);
}
.json-gutter {
  flex: 0 0 44px;
  overflow: hidden;
  padding: 8px 0;
  text-align: right;
  background: color-mix(in srgb, var(--panel) 70%, transparent);
  border-right: 1px solid var(--line-soft);
  user-select: none;
}
.json-ln {
  height: 18px;
  line-height: 18px;
  padding-right: 8px;
  font: 11px/18px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--text-dim-2);
}
.json-ta {
  flex: 1;
  border: 0;
  outline: none;
  resize: none;
  padding: 8px 10px;
  background: transparent;
  color: var(--text);
  font: 12px/18px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre;
  overflow: auto;
  tab-size: 2;
}
.json-status {
  margin: 6px 0 0;
  font-size: 12px;
}
.json-status.ok {
  color: var(--ok-text, #2e9e5b);
}
.json-status.err {
  color: var(--err-text, #d64545);
  word-break: break-all;
}
.json-save {
  margin-top: 8px;
}
</style>
