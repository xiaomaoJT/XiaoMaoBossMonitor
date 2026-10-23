<!-- Maintain 设置页：自 SettingsDrawer.vue 拆出，模板/逻辑零改动；状态·函数·emit 经父级 provide('sd') 注入 -->
<template>
  <section class="block">
    <h3>流自愈（持续异常自动恢复）</h3>
    <div class="opt col">
      <span>
        <strong>持续异常自动升级为系统重启</strong>
        <em>被监控通道「解码中断 / 网络断连」后后端会先无限退避重连；若仍长时间起不来，超过阈值即自动重启系统彻底恢复（对应「持续异常 · 解码中断」这类告警）</em>
      </span>
      <label class="opt-inline">
        <span class="switch" :class="{ on: opts.streamRecovery.enabled }" @click="opts.streamRecovery.enabled = !opts.streamRecovery.enabled"></span>
        <span class="muted">{{ opts.streamRecovery.enabled ? '已开启' : '已关闭' }}</span>
      </label>
    </div>
    <div class="opt" v-if="opts.streamRecovery.enabled">
      <span>
        <strong>触发阈值</strong>
        <em>被监控通道持续异常多少分钟后触发系统重启（默认 30 分钟）</em>
      </span>
      <div class="time-row">
        <input class="field mini" type="number" min="1" max="1440" step="1" v-model.number="opts.streamRecovery.restartSystemAfterMin" />
        <span class="tilde">分钟</span>
      </div>
    </div>

    <div class="divider"></div>

    <h3>定时重启系统</h3>
    <div class="opt col">
      <span>
        <strong>按「天 + 小时」定时重启</strong>
        <em>7x24 值守容易积累内存泄漏 / 解码器卡死，到间隔在后端点自愈式重启（重新拉起所有流与前端服务）。重启前会先推送一条通知</em>
      </span>
      <label class="opt-inline">
        <span class="switch" :class="{ on: opts.autoRestart.enabled }" @click="opts.autoRestart.enabled = !opts.autoRestart.enabled"></span>
        <span class="muted">{{ opts.autoRestart.enabled ? '已开启' : '已关闭' }}</span>
      </label>
    </div>
    <div class="opt" v-if="opts.autoRestart.enabled">
      <span>
        <strong>重启间隔</strong>
        <em>每过「N 天 + M 小时」重启一次（例如 1 天 0 小时 = 每天重启；0 天 6 小时 = 每 6 小时重启）</em>
      </span>
      <div class="time-row">
        <input class="field mini" type="number" min="0" max="365" step="1" v-model.number="opts.autoRestart.days" />
        <span class="tilde">天</span>
        <input class="field mini" type="number" min="0" max="23" step="1" v-model.number="opts.autoRestart.hours" />
        <span class="tilde">小时</span>
      </div>
    </div>

    <div class="divider"></div>

    <div class="opt col">
      <span>
        <strong>立即重启系统</strong>
        <em>
          桌面端走原生重启；浏览器 / 后端模式下向后端发重启请求。
          后端重启的流程是「先释放端口 → 拉起新进程 → 确认新进程真的接管端口才退出」，
          失败会自动回滚，不会把服务重启成停机。
        </em>
      </span>
      <button class="btn tiny danger" @click="restartSystemNow">立即重启</button>
    </div>

    <!-- 重启诊断：把「上一次重启到底怎么样了」摆出来。
         用户报过「自动重启没成功、直接停机」，根子就是以前没有可观测性 ——
         失败在日志里完全看不出来。 -->
    <div class="opt col restart-diag">
      <span>
        <strong>重启诊断</strong>
        <em v-if="!restartInfo">点右侧「刷新」查看后端上一次重启的结果与日志位置</em>
        <em v-else-if="!restartInfo.ok">
          未配置后端地址（浏览器 / 桌面端本地模式），或后端未响应；本地模式不需要看这个
        </em>
        <em v-else>
          {{
            restartInfo.lastAt
              ? `上次：${fmtRestartTime(restartInfo.lastAt)} · ${restartResultText(restartInfo.lastResult)}`
              : '还没有重启记录'
          }}
        </em>
      </span>
      <button class="btn tiny" @click="refreshRestartInfo">刷新</button>
    </div>
    <div class="restart-detail" v-if="restartInfo && restartInfo.ok && restartInfo.lastAt">
      <div class="kv"><span>结果</span><b>{{ restartResultText(restartInfo.lastResult) }}</b></div>
      <div class="kv" v-if="restartInfo.lastReason"><span>原因</span><b>{{ restartInfo.lastReason }}</b></div>
      <div class="kv" v-if="restartInfo.lastError"><span>详情</span><b>{{ restartInfo.lastError }}</b></div>
      <div class="kv" v-if="restartInfo.consecFailures">
        <span>连续失败</span><b class="warn">{{ restartInfo.consecFailures }} 次（连续失败会自动暂停自动重启）</b>
      </div>
      <div class="kv" v-if="restartInfo.logFile"><span>日志</span><b class="mono">{{ restartInfo.logFile }}</b></div>
      <div class="kv" v-if="restartInfo.restartedBy">
        <span>本进程</span><b>由自愈重启拉起（上游 pid={{ restartInfo.restartedBy }}）</b>
      </div>
      <div class="restart-history" v-if="restartInfo.history && restartInfo.history.length > 1">
        <div class="sub-label">最近几次</div>
        <div class="hrow" v-for="(h, i) in restartInfo.history.slice().reverse()" :key="i">
          <span class="mono">{{ fmtRestartTime(h.at) }}</span>
          <span>{{ restartResultText(h.result) }}</span>
          <span class="muted ellip">{{ h.reason }}</span>
        </div>
      </div>
    </div>

    <div class="divider"></div>

    <h3>系统级电源操作（重启 / 关机，最后手段）</h3>
    <div class="opt col">
      <span>
        <strong>允许控制整台电脑的电源</strong>
        <em>
          ⚠️ 这不是重启 BossMonitor 进程，而是<strong>动整台机器的电</strong>，会下线几分钟，
          且<strong>之后服务不会自己回来</strong>——除非你另配了开机自启
          （Windows 任务计划程序 / NSSM、macOS launchd、Linux systemd）。
          另外需要管理员 / root 权限（Windows 走 shutdown、Linux 走 systemctl、
          macOS 走 osascript 需「辅助功能」授权）。
          本开关同时解锁远程指令 <code>/hardreboot</code>（重启）与 <code>/shutdown</code>（关闭，比重启更彻底——断电后需人工开机或主板通电自启），两条都需二次确认。
          <template v-if="restartInfo && restartInfo.hardReboot">
            <br />本机重启将执行：<code>{{ restartInfo.hardReboot.command }}</code>
          </template>
          <template v-if="restartInfo && restartInfo.systemShutdown">
            <br />本机关机将执行：<code>{{ restartInfo.systemShutdown.command }}</code>
          </template>
        </em>
      </span>
      <label class="opt-inline">
        <span
          class="switch"
          :class="{ on: opts.systemReboot && opts.systemReboot.enabled }"
          @click="opts.systemReboot.enabled = !(opts.systemReboot && opts.systemReboot.enabled)"
        ></span>
        <span class="muted">{{ opts.systemReboot && opts.systemReboot.enabled ? '已开启' : '已关闭' }}</span>
      </label>
    </div>
    <div class="opt col" v-if="opts.systemReboot && opts.systemReboot.enabled">
      <span>
        <strong>自愈重启失败时自动兜底</strong>
        <em>
          只有当「拉起新进程失败 <b>且</b> 回滚也失败」（服务确实已经停机）时才会执行。
          默认关：因为硬重启会把整台机器带走，误触代价大。
        </em>
      </span>
      <label class="opt-inline">
        <span
          class="switch"
          :class="{ on: opts.systemReboot.onFailure }"
          @click="opts.systemReboot.onFailure = !opts.systemReboot.onFailure"
        ></span>
        <span class="muted">{{ opts.systemReboot.onFailure ? '已开启' : '已关闭' }}</span>
      </label>
    </div>
  </section>
</template>

<script setup>
import { inject } from 'vue'

/* 设置抽屉上下文（父级 SettingsDrawer 用 provide('sd', …) 暴露全部状态 / 函数 / emit / props） */
const sd = inject('sd')
const { emit, fmtRestartTime, opts, props, refreshRestartInfo, restartInfo, restartResultText, restartSystemNow } = sd
const { cameras, options, hiddenIds, layouts, layoutKey, native, events, openTab, tempSilent } = props
</script>
