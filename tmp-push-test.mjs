import { useAlertPush } from './src/composables/useAlertPush.js'

const states = []
const notes = []

// 场景 A：三个渠道全部关闭（不产生任何网络请求），只验证渠道定义能被正常读取
const options = {
  dingtalk: { enabled: false, webhook: '', secret: '', cameras: ['cam-1'], events: { motion: true, person: true } },
  wecom: { enabled: false, webhook: '', cameras: ['cam-1'], events: { motion: true, person: true } },
  telegram: { enabled: false, token: '', chatId: '', cameras: ['cam-1'], events: { motion: true, person: true } }
}
const push = useAlertPush(options, { onState: (...a) => states.push(a), notify: (t) => notes.push(t) })
console.log('A channels      :', JSON.stringify(push.channels()))

await push.handleAlarm({ key: 'k1', id: 'cam-1', name: '1#固定枪机', type: 'motion', ratio: 0.5, channels: { ding: true, wecom: true, tg: true } })
console.log('A onState       :', JSON.stringify(states))
states.length = 0

// 场景 B：渠道启用但凭据不完整 -> 走 ready() 分支，同样不发网络
options.dingtalk.enabled = true
options.wecom.enabled = true
options.telegram.enabled = true
console.log('B channels      :', JSON.stringify(push.channels()))
await push.handleAlarm({ key: 'k2', id: 'cam-1', name: '1#固定枪机', type: 'motion', ratio: 0.5, channels: { ding: true, wecom: true, tg: true } })
console.log('B onState       :', JSON.stringify(states))
states.length = 0

// 场景 C：sendDirect（巡检 / 状态通知）在无可用渠道时的返回
const r = await push.sendDirect({ title: 't', text: 'x', kind: 'patrol', key: 'k3', onState: (...a) => states.push(a) })
console.log('C sendDirect    :', JSON.stringify(r))

// 场景 D：通道级渠道开关（钉钉开、企微关）-> 只验证决策，不发网络
const push2 = useAlertPush(options, { onState: (...a) => states.push(a), notify: () => {} })
await push2.handleAlarm({ key: 'k4', id: 'cam-1', name: '1#固定枪机', type: 'person', ratio: 0.9, channels: { ding: true, wecom: false, tg: false } })
console.log('D onState       :', JSON.stringify(states.filter((s) => s[0] === 'k4')))
console.log('notes           :', JSON.stringify(notes))
