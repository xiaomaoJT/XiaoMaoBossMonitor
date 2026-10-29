<!-- Profiles 设置页：自 SettingsDrawer.vue 拆出，模板/逻辑零改动；状态·函数·emit 经父级 provide('sd') 注入 -->
<template>
  <section class="block">
    <div class="block-head">
      <h3>配置方案</h3>
      <span class="state-chip">{{ profiles.length ? `${profiles.length} 套已保存` : '尚未保存' }}</span>
    </div>
    <p class="hint">
      把当前的通道 + 全部设置存成一套「方案」，换场景时一键切换（比如「白天值守」/「夜间布防」）。
      也可以导出成 .json 文件备份，或在别的设备上导入。
    </p>

    <div class="opt col">
      <span>
        <strong>保存当前配置为新方案</strong>
        <em>会覆盖同名方案</em>
      </span>
      <div class="test-row">
        <input class="field" v-model.trim="profileName" placeholder="方案名称，例如：夜间布防" @keyup.enter="saveProfile" />
        <button class="btn small primary" @click="saveProfile">保存</button>
      </div>
    </div>

    <div class="profile-list" v-if="profiles.length">
      <div class="profile-item" v-for="p in profiles" :key="p.id" :class="{ on: p.id === activeProfileId }">
        <div class="pi-main">
          <strong>{{ p.name }}</strong>
          <em>{{ p.count }} 路通道 · {{ formatDate(p.updatedAt) }}</em>
        </div>
        <div class="pi-ops">
          <button class="btn small" :class="{ primary: p.id !== activeProfileId }" :disabled="p.id === activeProfileId" @click="applyProfile(p)">
            {{ p.id === activeProfileId ? '使用中' : '切换' }}
          </button>
          <button class="icon-btn" title="删除这套方案" @click="removeProfile(p.id)">
            <svg viewBox="0 0 24 24" width="15" height="15">
              <path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M5 7h14M10 7V5.5A1.5 1.5 0 0 1 11.5 4h1A1.5 1.5 0 0 1 14 5.5V7M7 7l1 12h8l1-12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
    <div class="empty-tip" v-else>还没有保存过方案</div>

    <div class="opt">
      <span>
        <strong>导出当前配置为文件</strong>
        <em>保存成 .json，可用于备份或迁移到其它设备</em>
      </span>
      <button class="btn small" @click="exportConfig">导出 .json</button>
    </div>

    <div class="opt">
      <span>
        <strong>从文件导入配置</strong>
        <em>导入后需要点下面的「保存」才会生效</em>
      </span>
      <button class="btn small" @click="pickFile">选择 .json 文件</button>
    </div>

    <div class="opt" v-if="backendEnabled">
      <span>
        <strong>导出运行数据库</strong>
        <em>把后端服务器上当前运行的 monitor.db（报警记录、人脸库、统计一并含 WAL 热备）下载到本机</em>
      </span>
      <button class="btn small primary" :disabled="dbExporting" @click="exportDatabase">
        {{ dbExporting ? '导出中…' : '导出 .db' }}
      </button>
    </div>
    <div class="opt" v-else>
      <span>
        <strong>导出运行数据库</strong>
        <em>数据库在后端服务器上（monitor.db）。请先在「后端检测」里开启并填写服务地址，才能导出。</em>
      </span>
      <button class="btn small" disabled>导出 .db</button>
    </div>

    <div class="opt col">
      <span>
        <strong>载入本地配置文件</strong>
        <em>
          选一份本机上的 .json 配置（通道名称 / 拉流地址 / 推送凭据 / 摆放坐标全套），
          一步填好整份配置。配置文件不在软件里，只在你自己手上。
        </em>
      </span>
      <div class="test-row">
        <button class="btn small primary" @click="pickHiddenFile">选择 .json 文件</button>
      </div>
      <span class="test-state" :class="hiddenState.kind" v-if="hiddenState.text">{{ hiddenState.text }}</span>
    </div>

    <!--
      恢复初始化：和上面的「载入本地配置文件」正好互为反向 ——
      一个载入那份完整配置，一个把所有配置清回空白。
      破坏性较强，所以走一次内联二次确认（不用弹窗，免得和抽屉的层叠打架）。
    -->
    <div class="opt col">
      <span>
        <strong>恢复初始化</strong>
        <em>把全部配置还原到空白：通道清空，三个推送渠道的凭据与绑定一并清空</em>
      </span>
      <button class="btn small danger" @click="askResetInit" v-if="!resetAsk">恢复初始化</button>
      <template v-else>
        <span class="reset-warn">
          会立即清空 <b>{{ cams.length }} 路通道</b>，以及钉钉 / 企业微信 / Telegram 的凭据与绑定通道；
          检测识别、报警提醒、播放性能、遮罩密码等全部回到默认。
          <b>已保存的配置方案与推送统计也会一并清空</b>。
        </span>
        <label class="reset-wipe" @click.prevent="resetWipeData = !resetWipeData">
          <span class="switch" :class="{ on: resetWipeData }"></span>
          <span class="rw-text">
            同时清空<b>报警记录</b>与<b>人脸库</b>
            <em>默认勾选 —— 「初始化」就该是什么都没有；想保留历史数据就取消勾选</em>
          </span>
        </label>
        <div class="test-row">
          <button class="btn small" @click="resetAsk = false">取消</button>
          <button class="btn small danger" @click="doResetInit">确认恢复</button>
        </div>
      </template>
    </div>

    <!--
      强制终结 App：点下去停止一切（播放 / 检测 / 推送 / 常亮）然后退出进程。
      iOS / 桌面端会真的杀掉进程；浏览器页面受安全策略限制关不掉，
      会停在一层「已终止」遮罩上，明说"请手动关页"，不假装退干净了。
    -->
    <div class="opt col">
      <span>
        <strong>强制终结 App</strong>
        <em>立即结束应用进程：停止播放、检测、推送与全部后台任务，然后自动退出</em>
      </span>
      <button class="btn small danger" @click="askExitApp" v-if="!exitAsk">强制终结 App</button>
      <template v-else>
        <span class="reset-warn">
          将<b>立即结束应用</b>：所有画面停止播放、检测与推送全部停止、后台不留任何任务，
          然后应用自动退出。这个操作不可撤销。
        </span>
        <div class="test-row">
          <button class="btn small" @click="exitAsk = false">取消</button>
          <button class="btn small danger" @click="doExitApp">确认终结</button>
        </div>
      </template>
    </div>

    <div class="opt col">
      <span>
        <strong>报警记录保留条数</strong>
        <em>记录与截图存在 IndexedDB，容量充足；超出会循环删除最旧的</em>
      </span>
      <div class="test-row">
        <input class="field mini" type="number" min="10" max="2000" step="10" v-model.number="opts.maxEvents" />
        <span class="unit">条</span>
      </div>
    </div>

    <div class="opt" v-if="storageInfo">
      <span>
        <strong>本地存储占用</strong>
        <em>报警记录 + 截图（IndexedDB）</em>
      </span>
      <span class="state-chip">{{ storageText }}</span>
    </div>
  </section>
</template>

<script setup>
import { inject } from 'vue'

/* 设置抽屉上下文（父级 SettingsDrawer 用 provide('sd', …) 暴露全部状态 / 函数 / emit / props） */
const sd = inject('sd')
const { activeProfileId, applyProfile, askExitApp, askResetInit, backendEnabled, cams, dbExporting, doExitApp, doResetInit, emit, exitAsk, exportConfig, exportDatabase, formatDate, hiddenState, pickHiddenFile, opts, pickFile, profileName, profiles, props, removeProfile, resetAsk, resetWipeData, saveProfile, storageInfo, storageText } = sd
const { cameras, options, hiddenIds, layouts, layoutKey, native, events, openTab, tempSilent } = props
</script>
