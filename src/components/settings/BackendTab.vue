<!-- Backend 设置页：自 SettingsDrawer.vue 拆出，模板/逻辑零改动；状态·函数·emit 经父级 provide('sd') 注入 -->
<template>
  <section class="block">
    <div class="block-head">
      <h3>后端检测服务</h3>
      <span class="state-chip" :class="backendState">{{ backendStateText }}</span>
    </div>
    <p class="hint">
      人形 / 人脸 / 姿态监听与推送整体搬到常驻设备，本机页面关了也在盯。
      开启后本机 AI 检测全部停掉（省算力、不发烫），检测与推送都交给后端服务。
    </p>
    <label class="opt">
      <span>
        <strong>启用后端检测</strong>
        <em>
          开启后本机 AI 检测全部停掉（省算力、不发烫），检测与推送都交给后端服务 ——
          关掉本机页面，服务端照旧检测、照旧往钉钉 / 企微 / Telegram 推送。
          当前配置（流地址 / 区域 / 推送凭据 / 人脸库）会自动同步过去，
          <b>不需要手改 server/config.json</b>。
        </em>
      </span>
      <span class="switch" :class="{ on: opts.backend && opts.backend.enabled }" @click="toggleBackend"></span>
    </label>
    <template v-if="opts.backend && opts.backend.enabled">
      <div class="opt col">
        <span>
          <strong>服务地址</strong>
          <em>
            先在电脑上运行 <code>npm run server</code> 启动 headless 服务，这里填它的地址；
            手机 / 手表端要填 Mac 的局域网 IP，不要填 localhost
          </em>
        </span>
        <input
          class="field wide"
          :value="opts.backend.url"
          placeholder="http://10.0.0.12:8787"
          @change="opts.backend.url = $event.target.value.trim()"
        />
      </div>
      <div class="opt col">
        <span>
          <strong>ffmpeg 路径（可选）</strong>
          <em>
            后端解码用 ffmpeg。市面平台的 H.265 常用「增强型 FLV」，
            npm 自带的 6.0 <b>解不了</b>（表现为各路「拉流失败」），需要 7 以上。
            装好后填这里（或直接放进系统 PATH），重启后端服务生效。
          </em>
        </span>
        <input
          class="field wide"
          v-model.trim="opts.backend.ffmpegPath"
          spellcheck="false"
          placeholder="留空 = 用 npm 自带版本（仅支持普通 H.264 FLV）"
        />
      </div>
      <div class="opt">
        <span>
          <strong>配置同步</strong>
          <em>
            通道 / 区域 / 推送凭据 / 人脸库改动后自动重发，无需操作。
            <b :class="syncState === 'error' ? 'err-text' : 'ok-text'">{{ syncStateText }}</b>
          </em>
        </span>
        <button class="tag" @click="onBackendSync">
          {{ syncState === 'syncing' ? '同步中…' : '立即同步' }}
        </button>
      </div>
      <!--
        反方向：从后端拉回整份配置。
        存在的理由：配置只存在**配它的那个浏览器**里，局域网里另一台机器
        打开同一个地址看到的是自己的空配置（一块空大屏）。
        换机器 / 重装 / 清了浏览器数据时，用它把后端那一份整体取回来。
      -->
      <div class="opt">
        <span>
          <strong>从后端拉取</strong>
          <em>
            把后端正在用的那份配置整体取回本机（通道 / 区域 / 凭据 / 人脸库）。
            换一台机器打开本地址时，本机是空的 —— 点这里拿回来即可，不用重配一遍。
            <b :class="behindBackend ? 'err-text' : 'ok-text'">本机 {{ localRevText }} · 后端 {{ syncRevText }}</b>
          </em>
          <em v-if="behindBackend" class="err-text">
            ⚠️ 后端配置比本机新（别的设备改过）。点右边按钮以它为准，本机这份会被替换。
          </em>
          <em v-else-if="pushOverwrote" class="err-text">
            ⚠️ 上一次同步把其它设备的改动覆盖掉了。
          </em>
          <!--
            本机底库是空的、后端还有人时，后端会**保住自己那份**（不让人推空）。
            这件事必须说出来并给出下一步，否则用户只会看到"同步成功"，
            而本机与后端的人脸库其实不一致。
          -->
          <em v-if="pushFacesSkipped" class="err-text">
            ⚠️ 本机人脸库是空的，后端已保留它自己的底库（没被推空）。点「从后端拉取」把后端的人取回来。
          </em>
          <em v-if="pullState === 'error'" class="err-text">拉取失败：{{ pullError }}</em>
        </span>
        <button class="tag" :disabled="pullState === 'pulling'" @click="onBackendPull">
          {{ pullState === 'pulling' ? '拉取中…' : '从后端拉取' }}
        </button>
      </div>
      <div class="opt">
        <span>
          <strong>拉取频率</strong>
          <em>轮询后端新事件的间隔，报警时效与流量的平衡</em>
        </span>
        <select class="field mini" v-model.number="opts.backend.pollMs">
          <option :value="2000">2 秒（最快）</option>
          <option :value="4000">4 秒（推荐）</option>
          <option :value="10000">10 秒</option>
          <option :value="30000">30 秒（最省）</option>
        </select>
      </div>
      <div class="opt">
        <span>
          <strong>服务状态</strong>
          <em>模型加载 / 人脸库 / 推送渠道 / 各通道解码情况，来自后端 /api/status</em>
        </span>
        <button class="tag" @click="onBackendTest">{{ backendTesting ? '查询中…' : '刷新' }}</button>
      </div>
      <!-- ---------- 状态哨兵：掉线提醒 + 定时巡检都由后端跑 ---------- -->
      <div v-if="backendWatchdog" class="opt col">
        <div class="backend-meta">
          <span>
            掉线提醒
            <b :class="backendWatchdog.statusAlerts && backendWatchdog.statusAlerts.enabled ? 'ok-text' : 'err-text'">
              {{ backendWatchdog.statusAlerts && backendWatchdog.statusAlerts.enabled ? '后端在盯' : '已关闭' }}
            </b>
            <template v-if="backendWatchdog.statusAlerts && backendWatchdog.statusAlerts.repeatMinutes">
              · 每 {{ backendWatchdog.statusAlerts.repeatMinutes }} 分钟重提醒
            </template>
          </span>
          <span>
            定时巡检
            <b :class="backendWatchdog.patrol && backendWatchdog.patrol.enabled ? 'ok-text' : 'err-text'">
              {{ backendWatchdog.patrol && backendWatchdog.patrol.enabled
                ? `每 ${backendWatchdog.patrol.intervalMinutes} 分钟`
                : '未启用' }}
            </b>
          </span>
          <span v-if="backendWatchdog.patrol && backendWatchdog.patrol.nextAt">
            下次：{{ formatCountdown(backendWatchdog.patrol.nextAt) }}
          </span>
          <span>在线：{{ (backendWatchdog.overview && backendWatchdog.overview.short) || '—' }}</span>
        </div>
        <div v-for="c in backendWatchdog.cameras || []" :key="'w-' + c.id" class="backend-cam">
          <b>{{ c.name }}</b>
          <b :class="c.state === 'playing' ? 'ok-text' : 'err-text'">{{ stateTextOf(c.state) }}</b>
          <span>
            {{ c.watched ? '已监听' : '未监听' }}
            <template v-if="c.fps"> · {{ c.fps }}fps</template>
            <template v-if="c.resolution"> · {{ c.resolution }}</template>
          </span>
        </div>
        <div v-if="backendWatchdog.lastAction" class="backend-note">
          最近动作：{{ backendWatchdog.lastAction }}
        </div>
      </div>
      <div v-if="backendStatus" class="opt col">
        <div class="backend-meta">
          <span>
            模型：
            <b :class="backendStatus.ai && backendStatus.ai.detector ? 'ok-text' : 'err-text'">人形</b>
            <b :class="backendStatus.ai && backendStatus.ai.face ? 'ok-text' : 'err-text'">人脸</b>
            <b :class="backendStatus.ai && backendStatus.ai.pose ? 'ok-text' : 'err-text'">姿态</b>
          </span>
          <span>人脸库 {{ backendStatus.faces || 0 }} 人</span>
          <span>
            ffmpeg
            <b :class="backendStatus.ffmpegTooOld ? 'err-text' : 'ok-text'">
              {{ backendStatus.ffmpeg || '未知' }}{{ backendStatus.ffmpegVersion ? ' · ' + backendStatus.ffmpegVersion : '' }}
            </b>
            <em v-if="backendStatus.ffmpegTooOld">（需 7 以上才能解 H.265 增强型 FLV）</em>
          </span>
          <span>
            推送：
            <b :class="backendStatus.push && backendStatus.push.ding ? 'ok-text' : 'err-text'">钉钉</b>
            <b :class="backendStatus.push && backendStatus.push.wecom ? 'ok-text' : 'err-text'">企微</b>
            <b :class="backendStatus.push && backendStatus.push.tg ? 'ok-text' : 'err-text'">TG</b>
          </span>
        </div>
        <div v-for="c in backendStatus.cameras || []" :key="c.id" class="backend-cam">
          <b>{{ c.name }}</b>
          <b :class="c.alive ? 'ok-text' : 'err-text'">{{ c.alive ? '解码中' : '未出帧' }}</b>
          <span>检出 {{ c.persons }} 人 · {{ c.zones }} 区域 · {{ c.frames }} 帧</span>
          <em v-if="c.error" class="err-text">{{ c.error }}</em>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup>
import { inject } from 'vue'

/* 设置抽屉上下文（父级 SettingsDrawer 用 provide('sd', …) 暴露全部状态 / 函数 / emit / props） */
const sd = inject('sd')
const { backendState, backendStateText, backendStatus, backendTesting, backendWatchdog, behindBackend, emit, formatCountdown, localRevText, onBackendPull, onBackendSync, onBackendTest, opts, props, pullError, pullState, pushFacesSkipped, pushOverwrote, stateTextOf, syncRevText, syncState, syncStateText, tg, toggleBackend } = sd
const { cameras, options, hiddenIds, layouts, layoutKey, native, events, openTab, tempSilent } = props
</script>
