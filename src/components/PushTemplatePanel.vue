<template>
  <div class="ptpl">
    <!-- ==================== 渠道切换 ==================== -->
    <div class="ch-tabs">
      <button
        v-for="c in CHANNELS"
        :key="c.id"
        class="ch-tab"
        :class="{ on: active === c.id }"
        @click="active = c.id"
      >
        {{ c.label }}
      </button>
    </div>

    <p class="lead">
      报警消息按下面的模板生成：<code>{变量}</code> 会在发送时替换成实际内容。
      没有值的项目（比如没开置信度）整行自动消失，不会留下一堆空字段。
      下方显示的就是当前生效的模板（未自定义时为内置默认），直接修改即可。
    </p>

    <!-- ==================== 编辑区 ==================== -->
    <div class="edit-head">
      <span class="edit-label">「{{ activeDef.label }}」推送模板</span>
      <div class="edit-ops">
        <button class="mini" @click="resetTpl">重置为内置默认</button>
      </div>
    </div>
    <textarea
      ref="taRef"
      v-model="tpl"
      class="field tpl-input"
      rows="14"
      spellcheck="false"
      :placeholder="activeDef.placeholder"
    ></textarea>

    <!-- ==================== 变量速查 ==================== -->
    <div class="vars">
      <span class="vars-title">可用变量（点击插入到光标处）：</span>
      <div class="vars-grid">
        <button
          v-for="v in TEMPLATE_VARS"
          :key="v.key"
          class="var-chip"
          :title="v.desc || v.sample"
          @click="insertVar(v.key)"
        >
          <code>{{ '{' + v.key + '}' }}</code>
          <span>{{ v.label }}</span>
        </button>
      </div>
    </div>

    <!-- ==================== 预览 ==================== -->
    <div class="edit-head">
      <span class="edit-label">推送效果预览（示例数据）</span>
      <div class="edit-ops">
        <button class="mini" @click="showSource = !showSource">{{ showSource ? '效果视图' : '源码视图' }}</button>
      </div>
    </div>
    <div class="preview" :class="{ src: showSource }">
      <template v-if="showSource">
        <pre>{{ previewText }}</pre>
      </template>
      <!-- 钉钉 / 企微的 markdown 渲染结果 -->
      <div v-else-if="active !== 'tg'" class="md-view" v-html="previewHtml"></div>
      <!-- Telegram 的 HTML 消息直接渲染，和群里看到的一致 -->
      <div v-else class="tg-view" v-html="previewText"></div>
    </div>
    <p class="hint">
      预览用的是示例数据（大门外 · 人形识别 87%）；实际推送时变量会换成真实内容。
      {{ active === 'tg' ? 'Telegram 支持 <b>粗体</b> <i>斜体</i> <a>链接</a> 标签。' : '加粗、引用、链接等 Markdown 语法在群里会正常渲染。' }}
    </p>
  </div>
</template>

<script setup>
import { computed, nextTick, ref } from 'vue'
import {
  collectAlarmVars,
  DEFAULT_TEMPLATES,
  renderTemplate,
  TEMPLATE_VARS
} from '../composables/useMessageTemplate'

const props = defineProps({
  /** 抽屉内部的编辑副本（opts.dingtalk / telegram / wecom），直接改它，随「保存并应用」落盘 */
  opts: { type: Object, required: true }
})

const CHANNELS = [
  { id: 'ding', label: '钉钉', cfgKey: 'dingtalk', placeholder: '空 = 内置默认模板' },
  { id: 'tg', label: 'Telegram', cfgKey: 'telegram', placeholder: '空 = 内置默认模板' },
  { id: 'wecom', label: '企业微信', cfgKey: 'wecom', placeholder: '空 = 内置默认模板' }
]

const active = ref('ding')
const activeDef = computed(() => CHANNELS.find((c) => c.id === active.value))

/** 当前编辑的模板。空值时显示内置默认 —— 用户看到的就是"当前生效的模板" */
const tpl = computed({
  get() {
    const cfg = props.opts[activeDef.value.cfgKey]
    return (cfg && cfg.template) || DEFAULT_TEMPLATES[active.value]
  },
  set(v) {
    const cfg = props.opts[activeDef.value.cfgKey]
    if (cfg) cfg.template = v
  }
})

const taRef = ref(null)

/** 把变量插到光标处（没有光标就追加到末尾） */
function insertVar(key) {
  const token = `{${key}}`
  const ta = taRef.value
  if (!ta) {
    tpl.value = (tpl.value || '') + token
    return
  }
  const start = ta.selectionStart ?? ta.value.length
  const end = ta.selectionEnd ?? start
  tpl.value = ta.value.slice(0, start) + token + ta.value.slice(end)
  nextTick(() => {
    ta.focus()
    const pos = start + token.length
    ta.setSelectionRange(pos, pos)
  })
}

/** 重置：清空自定义 → 回到内置默认模板 */
function resetTpl() {
  tpl.value = ''
}

/* ==================== 预览 ==================== */

/** 示例数据：尽量覆盖所有变量，让人看清每一行长什么样 */
const SAMPLE_RECORD = {
  id: 'cam-1',
  name: '大门外',
  type: 'person',
  ratio: 0.87,
  time: Date.now(),
  seq: 12,
  resolution: '1920×1080 · H265(HEVC)',
  fps: 25,
  kbps: 2860,
  roi: null,
  features: [
    { label: '人脸识别', on: true },
    { label: '人形姿态', on: false },
    { label: '区域规则', on: true },
    { label: '人员计数', on: false }
  ]
}

const previewText = computed(() => {
  const cfg = props.opts[activeDef.value.cfgKey] || {}
  const isTg = active.value === 'tg'
  const vars = collectAlarmVars(SAMPLE_RECORD, {
    cfg,
    screenshotUrl: '',
    linkUrl: 'https://t.me/example/123',
    note: '',
    style: isTg ? 'html' : 'md',
    omitShotLine: isTg
  })
  const source = tpl.value || DEFAULT_TEMPLATES[active.value]
  return isTg
    ? renderTemplate(source, vars, { escapeValue: true, skipEscapeKeys: ['link'] })
    : renderTemplate(source, vars)
})

const showSource = ref(false)

/** 极简 markdown → HTML：只处理消息模板里会用到的语法，够预览用 */
function mdToHtml(md) {
  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc(md)
    .split('\n')
    .map((line) => {
      let l = line
      // 链接与图片（图片行直接显示成文字说明，预览里不放真图）
      l = l.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<span class="md-img">🖼 $1</span>')
      l = l.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" onclick="return false">$1</a>')
      // 加粗
      l = l.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      // 标题
      if (/^###\s/.test(l)) return `<h4>${l.slice(4)}</h4>`
      if (/^##\s/.test(l)) return `<h4>${l.slice(3)}</h4>`
      // 引用
      if (/^>\s?/.test(l)) return `<span class="md-quote">${l.replace(/^>\s?/, '')}</span>`
      // 列表
      if (/^[-·]\s/.test(l)) return `<span class="md-li">${l}</span>`
      return l || '<span class="md-blank">　</span>'
    })
    .join('\n')
}

const previewHtml = computed(() => mdToHtml(previewText.value))
</script>

<style scoped>
.ptpl {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ch-tabs {
  display: flex;
  gap: 6px;
}

.ch-tab {
  flex: 1;
  height: 30px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--text-dim);
  background: color-mix(in srgb, var(--tint) 5%, transparent);
  border: 1px solid var(--line);
}

.ch-tab.on {
  color: var(--accent-text);
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}

.lead {
  margin: 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-dim);
}

.lead code {
  padding: 0 4px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--tint) 8%, transparent);
  font-size: 11px;
}

.edit-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.edit-label {
  font-size: 12px;
  color: var(--text-soft);
}

.edit-ops {
  display: flex;
  gap: 6px;
}

.mini {
  height: 22px;
  padding: 0 9px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-dim);
  background: color-mix(in srgb, var(--tint) 6%, transparent);
  border: 1px solid var(--line);
}

.mini:hover {
  color: var(--text);
  border-color: var(--line-strong);
}

.tpl-input {
  height: auto;
  min-height: 240px;
  padding: 10px;
  line-height: 1.7;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  resize: vertical;
  word-break: break-all;
}

/* ---------- 变量速查 ---------- */
.vars-title {
  font-size: 11px;
  color: var(--text-dim);
}

.vars {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.vars-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 5px;
}

.var-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 8px;
  border-radius: 7px;
  font-size: 11px;
  text-align: left;
  color: var(--text-dim);
  background: color-mix(in srgb, var(--tint) 5%, transparent);
  border: 1px solid var(--line-soft);
  overflow: hidden;
}

.var-chip code {
  color: var(--accent-text);
  font-size: 10px;
  flex: 0 0 auto;
}

.var-chip span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.var-chip:hover {
  color: var(--text);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
}

/* ---------- 预览 ---------- */
.preview {
  min-height: 180px;
  max-height: 420px;
  overflow: auto;
  padding: 12px 14px;
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-soft);
  background: color-mix(in srgb, var(--tint) 4%, transparent);
  border: 1px solid var(--line);
  word-break: break-all;
}

.preview.src pre {
  margin: 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-dim);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
}

/* markdown 渲染的各元素 */
.md-view :deep(h4) {
  margin: 2px 0 6px;
  font-size: 14px;
  color: var(--text-bright);
}

.md-view :deep(.md-quote) {
  display: block;
  padding-left: 8px;
  border-left: 2px solid var(--line-strong);
  color: var(--text-dim);
}

.md-view :deep(.md-li) {
  display: block;
  padding-left: 4px;
}

.md-view :deep(.md-blank) {
  display: block;
  height: 6px;
}

.md-view :deep(.md-img) {
  color: var(--text-dim-2);
}

.md-view :deep(a) {
  color: var(--accent-text);
  text-decoration: none;
}

/* Telegram 视图：模拟手机深色聊天气泡的阅读感 */
.tg-view {
  padding: 10px 12px;
  border-radius: 10px;
  background: #182533;
  border: 1px solid #223344;
  color: #e8eef8;
  line-height: 1.9;
}

.hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-dim-2);
}

@media (max-width: 640px) {
  .vars-grid {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
