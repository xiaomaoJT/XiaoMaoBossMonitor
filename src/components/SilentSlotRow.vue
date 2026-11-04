<script setup>
/*
 * 静默时段「单行」—— 全局定时静默与通道静默共用。
 *
 * 为什么单独提成组件（性能）：
 *   设置页 SettingsDrawer 是一个上万行的巨型组件，整页挂在同一个 reactive 配置对象上。
 *   原先每行时间 / 作用域下拉直接写在这个大组件模板里，改一个下拉（v-model 写 opts.silent.slots[i].scope）
 *   会让整个大组件重新渲染，下拉交互明显发「卡」。
 *   提成独立小组件后，下拉的变更只触发本行（极小）的重渲染，大组件不动 ——
 *   既修掉了卡顿，又没动任何功能（字段、校验、删除回调都和原来一致）。
 *
 * 时间输入：原生 `type="time"` 已改为**手动输入**（v2.2，见 §5.104）——
 *   原生控件点一下就弹系统选择层，值守大屏上改个时间要跟弹层搏斗。
 *   现在是普通文本框：敲 9:30 / 0930 都行，失焦时经 normalizeTimeText 归一化；
 *   解析不出回填原值，绝不把非法值写进配置（归一化收口在 defaults.js，前后端共用）。
 */
import { SLOT_SCOPES, normalizeTimeText } from '../config/defaults.js'

const props = defineProps({
  slot: { type: Object, required: true },
  index: { type: Number, required: true },
  canRemove: { type: Boolean, default: true }
})
const emit = defineEmits(['remove'])

/** 手动输入的时间失焦/回车时归一化；解析不出回填原值 */
function commitTime(slot, key, e) {
  const v = normalizeTimeText(e.target.value, slot[key])
  slot[key] = v
  e.target.value = v
}
</script>

<template>
  <div class="slot-row">
    <span class="slot-idx">{{ index + 1 }}</span>
    <input
      class="field mini"
      type="text"
      inputmode="numeric"
      maxlength="5"
      placeholder="HH:MM"
      title="手动输入时间，如 22:00"
      :value="slot.start"
      @change="commitTime(slot, 'start', $event)"
    />
    <span class="tilde">~</span>
    <input
      class="field mini"
      type="text"
      inputmode="numeric"
      maxlength="5"
      placeholder="HH:MM"
      title="手动输入时间，如 08:00"
      :value="slot.end"
      @change="commitTime(slot, 'end', $event)"
    />
    <select class="field mini scope" v-model="slot.scope" title="作用域：这个时段在哪些日子生效">
      <option v-for="sc in SLOT_SCOPES" :key="sc.id" :value="sc.id">{{ sc.label }}</option>
    </select>
    <span class="slot-tag invalid" v-if="slot.start === slot.end">起止相同，不生效</span>
    <span class="slot-tag cross" v-else-if="slot.end < slot.start">跨零点</span>
    <button
      class="btn tiny danger slot-del"
      title="删除这个时段"
      :disabled="!canRemove"
      @click="emit('remove')"
    >
      删除
    </button>
  </div>
</template>

<style scoped>
.slot-row {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid var(--line-soft);
  background: var(--panel);
}

.slot-idx {
  flex: 0 0 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 10.5px;
  color: var(--text-dim-2);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.slot-row .field.mini {
  width: 84px;
}

.slot-tag {
  font-size: 10.5px;
  color: var(--text-dim-2);
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--line-soft);
}

/* 跨零点 = 正常用法，给个中性偏暖的提示 */
.slot-tag.cross {
  color: var(--warn-text);
  border-color: color-mix(in srgb, var(--warn) 30%, transparent);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
}

/* 起止相同 = 这个时段永远不会命中，必须显眼地警示 */
.slot-tag.invalid {
  color: var(--err-text);
  border-color: color-mix(in srgb, var(--err) 38%, transparent);
  background: color-mix(in srgb, var(--err) 10%, transparent);
}

.field.mini.scope {
  width: auto;
  min-width: 92px;
  padding: 3px 6px;
}

.slot-del {
  margin-left: auto;
}
</style>
