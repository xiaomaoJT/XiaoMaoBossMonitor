<!-- Face 设置页：自 SettingsDrawer.vue 拆出，模板/逻辑零改动；状态·函数·emit 经父级 provide('sd') 注入 -->
<template>
  <section class="block">
    <div class="block-head">
      <h3>人脸识别</h3>
      <span class="head-chips">
        <span class="state-chip" :class="opts.face.enabled ? 'ready' : ''">
          {{ opts.face.enabled ? '已启用' : '未启用' }}
        </span>
        <span class="state-chip" :class="gpuReady ? 'ready' : ''">{{ gpuText }}</span>
      </span>
    </div>
    <p class="hint">
      SCRFD 人脸检测 + MobileFaceNet 特征 + 本地人脸库。识别到已录入的人会用姓名播报与推送，
      并输出性别 / 年龄与口罩、眼镜等属性（两项可分别关闭，见下）。
      前提是「检测识别」页的<b>人形识别（AI）</b>已开启。
    </p>

    <label class="opt">
      <span>
        <strong>开启人脸识别</strong>
        <em>识别到已录入的人会用姓名播报与推送；此时才会加载人脸模型</em>
      </span>
      <span class="switch" :class="{ on: opts.face.enabled }" @click="opts.face.enabled = !opts.face.enabled"></span>
    </label>

    <template v-if="opts.face.enabled">
      <div class="opt">
        <span>
          <strong>人脸检测阈值</strong>
          <em>越高越严格</em>
        </span>
        <div class="range-row">
          <input type="range" min="0.3" max="0.9" step="0.05" v-model.number="opts.face.score" />
          <b>{{ Number(opts.face.score).toFixed(2) }}</b>
        </div>
      </div>

      <div class="opt">
        <span>
          <strong>同一个人判定阈值</strong>
          <em>相似度高于该值才算同一个人（越高越不容易认错，但可能认不出）</em>
        </span>
        <div class="range-row">
          <input type="range" min="0.25" max="0.6" step="0.01" v-model.number="opts.face.matchThreshold" />
          <b>{{ Number(opts.face.matchThreshold).toFixed(2) }}</b>
        </div>
      </div>

      <label class="opt">
        <span>
          <strong>识别到已录入的人时报警</strong>
          <em>关闭后只做人脸库比对，不产生事件</em>
        </span>
        <span class="switch" :class="{ on: opts.face.eventOnKnown }" @click="opts.face.eventOnKnown = !opts.face.eventOnKnown"></span>
      </label>

      <label class="opt">
        <span>
          <strong>陌生人脸也记事件</strong>
          <em>默认关：未录入的人脸会出现在下面「待录入」里，但不会刷报警</em>
        </span>
        <span class="switch" :class="{ on: opts.face.eventOnUnknown }" @click="opts.face.eventOnUnknown = !opts.face.eventOnUnknown"></span>
      </label>

      <label class="opt">
        <span>
          <strong>收集陌生人脸</strong>
          <em>把没录入的人脸暂存到「待录入」，方便事后一键建档</em>
        </span>
        <span class="switch" :class="{ on: opts.face.collectUnknown }" @click="opts.face.collectUnknown = !opts.face.collectUnknown"></span>
      </label>

      <label class="opt">
        <span>
          <strong>画面上显示人脸框</strong>
          <em>识别到的人脸框上会标出姓名</em>
        </span>
        <span class="switch" :class="{ on: opts.face.drawBox }" @click="opts.face.drawBox = !opts.face.drawBox"></span>
      </label>

      <!--
        属性模型两个开关（缺省都开 = 升级前的行为；显式 false 才关）。
        解析收口在 defaults.faceAttrConf，前后端共用同一份口径。
        关掉 = ① 不再加载模型（headless 会顺手释放已加载的会话）
               ② 事件/统计/推送里该字段为 null（不显示假的"未知"）。
      -->
      <label class="opt">
        <span>
          <strong>识别性别 / 年龄</strong>
          <em>genderage 模型（1.3MB）。关掉后事件与统计里不再有性别年龄；年龄为模型估算，只宜当粗标签</em>
        </span>
        <span class="switch" :class="{ on: opts.face.genderAge !== false }" @click="opts.face.genderAge = opts.face.genderAge === false"></span>
      </label>

      <label class="opt">
        <span>
          <strong>识别口罩 / 眼镜</strong>
          <em>face_attrib_net 模型（43MB 外部权重，每帧一次 128×128 推理）。不看这类标签就关掉，省一次推理与 43MB 内存</em>
        </span>
        <span class="switch" :class="{ on: opts.face.attrib !== false }" @click="opts.face.attrib = opts.face.attrib === false"></span>
      </label>

      <label class="opt">
        <span>
          <strong>属性标签阈值</strong>
          <em>口罩 / 眼镜 / 墨镜 / 闭眼这些标签，模型给的概率高于它才判定「有」（%）。默认 50；调低更易判定、调高更保守。前后端共用同一份</em>
        </span>
        <div class="test-row">
          <input class="field mini" type="number" min="10" max="90" step="5" v-model.number="opts.face.attribThreshold" />
          <span class="unit">%</span>
        </div>
      </label>

      <div class="opt">
        <span>
          <strong>同一个人报警间隔</strong>
          <em>同一个人两次人脸事件的最小间隔</em>
        </span>
        <div class="test-row">
          <input class="field mini" type="number" min="3" max="600" v-model.number="opts.face.cooldownSec" />
          <span class="unit">秒</span>
        </div>
      </div>

      <!-- 命中确认（默认关 = 见到在库人脸就推）。
           判定收口在 defaults.hitConfirmStep，与后端 analyzer 共用同一份状态机。 -->
      <label class="opt">
        <span>
          <strong>命中需重复出现才报警</strong>
          <em>
            关闭（默认）：见到在库人脸就推。开启：同一个人在窗口内重复出现够次数才推，
            可挡掉"背影/侧脸像了一下"的偶发误命中
          </em>
        </span>
        <span
          class="switch"
          :class="{ on: opts.face.hitConfirm }"
          @click="opts.face.hitConfirm = !opts.face.hitConfirm"
        ></span>
      </label>

      <div class="opt" v-if="opts.face.hitConfirm">
        <span>
          <strong>确认窗口</strong>
          <em>窗口内每见到一次就刷新计时；够次数即报警，然后重新开始数</em>
        </span>
        <div class="test-row">
          <input class="field mini" type="number" min="10" max="3600" v-model.number="opts.face.hitConfirmSec" />
          <span class="unit">秒</span>
        </div>
      </div>

      <div class="opt" v-if="opts.face.hitConfirm">
        <span>
          <strong>确认次数</strong>
          <em>窗口内需要重复出现几次才报警</em>
        </span>
        <div class="test-row">
          <input class="field mini" type="number" min="2" max="20" v-model.number="opts.face.hitConfirmTimes" />
          <span class="unit">次</span>
        </div>
      </div>

      <!-- 命中分差门槛（默认 0.08）：判定收口在 vecMatch.hitMarginThreshold / hitMarginPassed，
           酒店长相相似度高时，最像的人必须明显比第二像的人高出 margin 才确认命中，
           差得不够远就当没认出，从根上砍掉"长得像就乱认"的误命中。 -->
      <div class="opt">
        <span>
          <strong>命中分差门槛</strong>
          <em>
            最像的人必须比第二像的人高出该差值才确认命中（酒店长相相似度高时尤其有用）。
            填 0 = 关闭，回到"只看最像分 ≥ 阈值"的历史行为
          </em>
        </span>
        <div class="range-row">
          <input
            type="range"
            min="0"
            max="0.5"
            step="0.01"
            v-model.number="opts.face.hitMargin"
          />
          <b>{{ Number(opts.face.hitMargin) > 0 ? Number(opts.face.hitMargin).toFixed(2) : '关' }}</b>
        </div>
      </div>

      <!-- 命中质量门槛（默认关）：判定收口在 defaults.faceQualityConf / faceQualityPassed / yawFromKps，
           没有独立的模糊/遮挡模型，用三个可量化代理：检测分、框占比、侧脸偏航。 -->
      <label class="opt">
        <span>
          <strong>命中质量门槛</strong>
          <em>
            关闭（默认）：历史行为，检测到的脸都参与命中判定。
            开启：检测分过低 / 脸太小 / 侧脸转太多 的帧不判命中，减少低质量误认
          </em>
        </span>
        <span
          class="switch"
          :class="{ on: opts.face.quality.enabled }"
          @click="opts.face.quality.enabled = !opts.face.quality.enabled"
        ></span>
      </label>

      <template v-if="opts.face.quality.enabled">
        <div class="opt">
          <span>
            <strong>最低检测分</strong>
            <em>检测置信度低于该值的脸不判命中（默认 0.70；识别阈值应高于检测阈值）</em>
          </span>
          <div class="range-row">
            <input type="range" min="0.3" max="1" step="0.01" v-model.number="opts.face.quality.minScore" />
            <b>{{ Number(opts.face.quality.minScore).toFixed(2) }}</b>
          </div>
        </div>
        <div class="opt">
          <span>
            <strong>最小框占比</strong>
            <em>脸框占画面面积低于该比例不判命中（默认 0.010）；太小的人脸容易误认</em>
          </span>
          <div class="range-row">
            <input type="range" min="0.001" max="0.3" step="0.001" v-model.number="opts.face.quality.minBoxRatio" />
            <b>{{ Number(opts.face.quality.minBoxRatio).toFixed(3) }}</b>
          </div>
        </div>
        <div class="opt">
          <span>
            <strong>最大侧脸偏航</strong>
            <em>侧脸转角超过该值（鼻尖相对眼连线的归一化偏航）不判命中（默认 0.40；0=不卡）</em>
          </span>
          <div class="range-row">
            <input type="range" min="0.1" max="1.5" step="0.05" v-model.number="opts.face.quality.maxYaw" />
            <b>{{ Number(opts.face.quality.maxYaw).toFixed(2) }}</b>
          </div>
        </div>
      </template>
      <!-- 每帧识别人数上限（默认 2）：多人识别 + 性能保护，判定收口在 defaults.faceMaxFaces。
           画面多个人时按框面积取最显眼的前 N 张做识别，其余只画框不识别。 -->
      <div class="opt">
        <span>
          <strong>每帧识别人数上限</strong>
          <em>
            画面里多个人时，每帧最多对多少张脸做识别（按框面积取最显眼的）。
            默认 2，兼顾性能与"能分辨多个人"；调大可一次认更多人，代价是每帧算力更高
          </em>
        </span>
        <div class="range-row">
          <input type="range" min="1" max="12" step="1" v-model.number="opts.face.maxFaces" />
          <b>{{ Number(opts.face.maxFaces) >= 1 ? Number(opts.face.maxFaces) : 2 }} 人</b>
        </div>
      </div>

      <div class="opt">
        <span>
          <strong>人脸库容量</strong>
          <em>满了必须先删人才能继续录入；调小到当前人数以下时，保存前会明确警告并自动淘汰最旧的人</em>
        </span>
        <div class="test-row">
          <input class="field mini" type="number" min="1" max="500" v-model.number="opts.face.libMax" />
          <span class="unit">人</span>
        </div>
      </div>

      <!-- 采集调优（高级）：三个原本写死在代码里的旋钮。
           缺省值 = 原常量，所以不动它就与升级前完全一致。 -->
      <div class="opt">
        <span>
          <strong>采集调优（高级）</strong>
          <em>抓不到人脸时再动这里；改动会影响识别开销</em>
        </span>
        <div class="test-row">
          <button class="mini-btn ghost" @click="faceTuneOpen = !faceTuneOpen">
            {{ faceTuneOpen ? '收起' : '展开' }}
          </button>
        </div>
      </div>

      <template v-if="faceTuneOpen">
        <div class="opt">
          <span>
            <strong>失败重试间隔</strong>
            <em>提特征失败后多久允许再试；越小越能抓住「人站着但那一帧没提成功」</em>
          </span>
          <div class="test-row">
            <input class="field mini" type="number" min="100" max="5000" step="50" v-model.number="opts.face.retryMs" />
            <span class="unit">毫秒</span>
          </div>
        </div>

        <div class="opt">
          <span>
            <strong>同一人重提间隔</strong>
            <em>同一个人的脸多少秒内不重复提特征（省算力）</em>
          </span>
          <div class="test-row">
            <input class="field mini" type="number" min="2" max="60" v-model.number="opts.face.dedupeSec" />
            <span class="unit">秒</span>
          </div>
        </div>

        <div class="opt">
          <span>
            <strong>头部补检范围</strong>
            <em>按人形框顶部多大比例裁剪放大再检（救远处漏检的脸）；越大越费算力</em>
          </span>
          <div class="range-row">
            <input type="range" min="0.2" max="0.9" step="0.05" v-model.number="opts.face.headRatio" />
            <b>{{ Number(opts.face.headRatio).toFixed(2) }}</b>
          </div>
        </div>

        <div class="opt">
          <span>
            <strong>检测输入边长</strong>
            <em>调大能救更远的脸，代价是每帧推理更慢。非 640 时后端日志会打 ONNX 形状告警（无害，模型是动态导出的）</em>
          </span>
          <div class="test-row">
            <select class="field mini" v-model.number="opts.face.detSize">
              <option v-for="s in FACE_DET_SIZES" :key="s" :value="s">{{ s }}</option>
            </select>
            <span class="unit">像素</span>
          </div>
        </div>

        <div class="opt">
          <span>
            <strong>待录入队列容量</strong>
            <em>
              攒满这么多张未录入人脸就滚动删最旧的（新的照收）；同时是「满库」提醒阈值。
              0 = 自动（后端 100 / 纯前端 24）
            </em>
          </span>
          <div class="test-row">
            <input class="field mini" type="number" min="0" max="500" v-model.number="opts.face.pendingFullAt" />
            <span class="unit">张</span>
          </div>
        </div>

        <div class="opt">
          <span>
            <strong>重复捕获合并间隔</strong>
            <em>
              同一个人在间隔内被反复采到，只刷新已有那条（不新增）；间隔外再来才给一条新鲜样本。
              0 = 关闭去重（每张都单独保留）。默认 300 秒
            </em>
          </span>
          <div class="test-row">
            <input class="field mini" type="number" min="0" max="86400" v-model.number="opts.face.pendingDedupeSec" />
            <span class="unit">秒</span>
          </div>
        </div>

        <div class="opt">
          <span>
            <strong>满库预警线</strong>
            <em>到容量的这个比例先提醒一次（默认 0.8）；再涨到满会再提醒一次</em>
          </span>
          <div class="range-row">
            <input type="range" min="0.5" max="0.99" step="0.05" v-model.number="opts.face.pendingWarnRatio" />
            <b>{{ Math.round((Number(opts.face.pendingWarnRatio) || 0.8) * 100) }}%</b>
          </div>
        </div>

        <div class="opt">
          <span>
            <em>这几个值会随配置同步到后端检测服务；改完记得点右下角「保存并应用」</em>
          </span>
          <div class="test-row">
            <button class="mini-btn ghost" @click="resetFaceTune">恢复默认</button>
          </div>
        </div>
      </template>

      <!-- 待录入（前端 / 后端检测到的都会列进来）
           ⚠️ 这一块**刻意不挂 v-if**。
           以前是 v-if="allPendingFaces.length"，空的时候整块直接消失 ——
           于是「后端没连上」「没开收集陌生人脸」「确实没人来过」三种情况
           在界面上长得一模一样：都是一片空白。用户只能反复点刷新，
           或者以为「抓到的脸没进库」。空态必须自己开口说话。 -->
      <div class="opt col">
        <span>
          <strong>
            待录入人脸（{{ allPendingFaces.length }}）
            <button class="mini-btn ghost" @click="pendingLibOpen = !pendingLibOpen">
              {{ pendingLibOpen ? '收起' : '管理' }}
            </button>
          </strong>
          <em
            >按「人脸尺寸 + 清晰度 + 正脸程度」排好序了：优先录「优 / 良」，侧脸和糊脸录进去会拉低整个名字的识别率</em
          >
        </span>

          <div class="face-grid" ref="pendingGridEl" v-if="pendingLibOpen && allPendingFaces.length">
          <div class="face-card pending" v-for="pf in pagedPending" :key="pf.id">
            <img
              :src="pf.thumb"
              alt="待录入人脸"
              class="pending-thumb"
              :class="{ clickable: pf.full }"
              :title="pf.full ? '点击查看捕获时的原图' : ''"
              @click="pf.full && openPendingShot(pf)"
            />
            <!-- 样本质量（尺寸 + 清晰度 + 正脸程度）：挑「哪张值得录」用。
                 侧脸/糊脸录进去会拉低整个名字的匹配，所以先把好的排在前面 -->
            <span
              class="pf-score"
              :class="[pfQuality(pf).tone, { rec: pfRecommended(pf) }]"
              :title="pfScoreTip(pf)"
              >{{ pfQuality(pf).text }}</span
            >
            <span class="face-meta">{{ pf.camName || '未知通道' }}</span>
            <span class="face-time" v-if="pf.at">{{ fmtPendingAt(pf.at) }}</span>
            <!-- 属性徽标：性别 / 年龄 / 口罩眼镜（后端检测顺手算；无则整行不出现） -->
            <span class="face-attrs" v-if="faceAttrText(pf)">{{ faceAttrText(pf) }}</span>
            <!-- 录入时手动归入：选已知的人（同名归到他那一堆）或自定义名字；留空=自动编号，保持旧行为 -->
            <div class="face-assign" v-if="faceNameOptions.length">
              <FaceAssignSelect
                v-model="pendingAssign[pf.id]"
                :options="faceNameOptions"
                placeholder="新建（自动编号）"
                :custom="true"
                custom-placeholder="自定义名字"
                :disabled="enrollingPending[pf.id]"
              />
            </div>
            <div class="face-acts">
              <button class="mini-btn" :disabled="enrollingPending[pf.id]" @click="doAddPending(pf)">
                {{ enrollingPending[pf.id] ? '录入中' : '录入' }}
              </button>
              <button class="mini-btn ghost" v-if="!enrollingPending[pf.id]" :disabled="enrollingPending[pf.id]" @click="doIgnorePending(pf)">忽略</button>
            </div>
          </div>
        </div>

        <!-- 空态占位（展开且没有待录入时）：把「为什么是空的」说清楚，并给一条能立刻做的动作 -->
        <div class="pending-empty" v-else-if="pendingLibOpen">
          <span class="pe-icon" aria-hidden="true">{{ pendingEmpty.icon }}</span>
          <div class="pe-body">
            <strong class="pe-title">{{ pendingEmpty.title }}</strong>
            <em class="pe-hint">{{ pendingEmpty.hint }}</em>
          </div>
        </div>

        <!-- 收起状态下的「空白」摘要：默认收起不等于让空白无声无息 ——
             数量为 0 时仍给一行，说明为什么是空的；想知道细节再点「管理」。 -->
        <p class="hint tight" v-if="!pendingLibOpen && !allPendingFaces.length">
          {{ pendingEmpty.title }} · 点「管理」查看原因
        </p>

        <div class="face-pager" v-if="pendingLibOpen && pendingPageCount > 1">
          <button class="mini-btn ghost" :disabled="pendingPage <= 1" @click="pendingPage -= 1">上一页</button>
          <span class="face-page-text">{{ pendingPage }} / {{ pendingPageCount }}</span>
          <button class="mini-btn ghost" :disabled="pendingPage >= pendingPageCount" @click="pendingPage += 1">下一页</button>
        </div>
        <div class="face-acts" v-if="pendingLibOpen">
          <button class="mini-btn ghost" @click="togglePendingSort">
            {{ pendingSort === 'score' ? '排序：质量优先' : '排序：时间优先' }}
          </button>
          <button class="mini-btn ghost" v-if="allPendingFaces.length && pendingPageCount > 1" @click="doIgnorePagePending">本页忽略</button>
          <button class="mini-btn danger" v-if="allPendingFaces.length" @click="doIgnoreAllPending">全部忽略</button>
          <button
            class="mini-btn ghost"
            v-if="faceBackendOn"
            :disabled="pendingRefreshing"
            @click="refreshBackendPending"
          >
            {{ pendingRefreshing ? '刷新中…' : '刷新待录入' }}
          </button>
          <span class="muted" v-if="faceBackendOn && !pendingRefreshNote">来自后端检测服务</span>
          <span class="muted pending-refresh-note" v-if="pendingRefreshNote">{{ pendingRefreshNote }}</span>
        </div>
      </div>

      <!-- 命中修正（仅后端模式：命中样本由后端检测服务存着）
           已入库人脸的命中以前只发事件、不存向量 —— 想修正「认成小刘、
           实际是大刘」这种错判时，手里只剩一张图，没有 512 维向量可重新录入。
           后端现在每次命中都存下当帧向量 + 当时认定的名字，这里列出最近 20 条，
           确认认错后按正确名字「修正」：这条向量会作为一条正确标签的样本
           录进人脸库（自动同步到后端），后续同一张脸的余弦相似度就会落到
           对的人名下 —— 识别精准度随之提升。 -->
      <div class="opt col" v-if="faceBackendOn">
        <span>
          <strong>
            命中修正（{{ backendFaceHits.length }}）
            <button class="mini-btn ghost" @click="hitReviewOpen = !hitReviewOpen">
              {{ hitReviewOpen ? '收起' : '管理' }}
            </button>
          </strong>
          <em>最近 {{ backendFaceHits.length }} 条命中样本（带原图）；认错了就按正确名字修正，提升后续识别精准度</em>
        </span>

        <!-- 命中卡片比待录入/人脸库复杂（图 + 4 行信息 + 下拉 + 3 个按钮），
             用 hit-grid 固定 3 列摊满宽度，内部改成「图在左、信息在右」的横排，
             底部按钮行允许换行、绝不裁成半个字 -->
        <div class="face-grid hit-grid" v-if="hitReviewOpen && backendFaceHits.length">
          <div class="face-card hit" v-for="h in backendFaceHits" :key="h.id">
            <div class="hit-top">
              <img
                :src="h.thumb"
                alt="命中人脸"
                class="pending-thumb"
                :class="{ clickable: h.full }"
                :title="h.full ? '点击查看命中时的原图' : ''"
                @click="h.full && openPendingShot(h)"
              />
              <div class="hit-info">
                <span class="hit-cur" :title="h.name || '未识别'">认成：{{ h.name || '未识别' }}</span>
                <span class="face-meta">相似度 {{ (h.score * 100).toFixed(0) }}%</span>
                <span class="face-meta">{{ h.camName || '未知通道' }}</span>
                <span class="face-time" v-if="h.at">{{ fmtPendingAt(h.at) }}</span>
                <!-- 属性徽标：性别 / 年龄 / 口罩眼镜（后端检测顺手算；无则整行不出现） -->
                <span class="face-attrs" v-if="faceAttrText(h)">{{ faceAttrText(h) }}</span>
              </div>
            </div>
            <!-- 正确名字：选库里已有的人，或选「自定义」填一个；修正 = 按这个名字把样本录进人脸库 -->
            <div class="face-assign" v-if="faceNameOptions.length">
              <FaceAssignSelect
                v-model="hitAssign[h.id]"
                :options="faceNameOptions"
                placeholder="选正确的人"
                :custom="true"
                custom-placeholder="自定义正确名字"
                :disabled="fixingHit[h.id]"
              />
            </div>
            <div class="face-acts">
              <button class="mini-btn" :disabled="fixingHit[h.id]" @click="doFixHit(h)">
                {{ fixingHit[h.id] ? '修正中' : '修正' }}
              </button>
              <!-- 「认错」= 陌生人被误认成了库里某人：忽略只删样本不治本，
                   标记成反例后，匹配时反例更相似即判未录入，同一张脸不再冒名。
                   ⚠️ 与「修正」的分工必须靠 title 说清：修正是「这人其实是库里的某个真人」，
                   认错是「这人谁都不是，只是长得像」。标错会把真人拦成陌生人。 -->
              <button
                class="mini-btn ghost"
                :disabled="fixingHit[h.id]"
                title="这条其实是陌生人，被误认成了「{{ h.name || '未识别' }}」——标记后同一张脸再来会直接判未录入"
                @click="doMarkStranger(h)"
              >
                认错
              </button>
              <button class="mini-btn ghost" :disabled="fixingHit[h.id]" @click="doIgnoreHit(h)">忽略</button>
            </div>
          </div>
        </div>

        <!-- 空态占位：把「为什么是空的」说清楚，并给一条能立刻做的动作 -->
        <div class="pending-empty" v-else-if="hitReviewOpen">
          <span class="pe-icon" aria-hidden="true">{{ hitEmpty.icon }}</span>
          <div class="pe-body">
            <strong class="pe-title">{{ hitEmpty.title }}</strong>
            <em class="pe-hint">{{ hitEmpty.hint }}</em>
          </div>
        </div>

        <div class="face-acts hit-toolbar" v-if="hitReviewOpen">
          <button class="mini-btn ghost" :disabled="hitRefreshing" @click="refreshBackendFaceHits">
            {{ hitRefreshing ? '刷新中…' : '刷新命中' }}
          </button>
          <button
            class="mini-btn ghost danger"
            :disabled="hitRefreshing || !backendFaceHits.length"
            title="忽略当前列出的全部命中样本（不修正、也不标记反例，仅从列表移除）"
            @click="doIgnoreAllHits"
          >
            全部忽略
          </button>
          <span class="muted" v-if="!hitRefreshNote">来自后端检测服务</span>
          <span class="muted pending-refresh-note" v-if="hitRefreshNote">{{ hitRefreshNote }}</span>
        </div>
      </div>

      <!-- 陌生人标记（反例）：被误认成库里某人的陌生脸
           标记 = 把这条脸的向量存成反例；匹配时「反例分 ≥ 阈值且 ≥ 库内最像分」
           即判未录入，之后同一张脸再来直接走待录入/陌生人路径，不再冒名。
           库里真人本人不受影响（对自己样本 ~0.9，天然压过对陌生反例的分）。
           与拆分声明同模式：IndexedDB 为源、随配置同步后端、重启恢复。 -->
      <div class="opt col" v-if="faceBackendOn">
        <span>
          <strong>
            陌生人标记（{{ strangerMarks.length }}）
            <button class="mini-btn ghost" @click="blockLibOpen = !blockLibOpen">
              {{ blockLibOpen ? '收起' : '管理' }}
            </button>
          </strong>
          <em>被误认成库里某人的陌生脸；按被认错次数从高到低排序，最常被冒名的排最前、最该录入人脸库。标记后同一张脸再来会直接判「未录入」，不再冒名</em>
        </span>

        <div class="face-grid" v-if="blockLibOpen && strangerMarks.length">
          <div class="face-card block" v-for="b in strangerMarks" :key="b.id">
            <img :src="b.thumb" alt="陌生人脸" class="pending-thumb" />
            <!-- 标签与名字**分行**：名字是这里最该看清的结论（"拦的是谁"），
                 以前和「曾被认成：」挤一行，名字稍长就被 ellipsis 切半 -->
            <span class="hit-cur">曾被认成</span>
            <strong class="block-name" :title="b.name">{{ b.name || '未知' }}</strong>
            <!-- 合并计数：同一个陌生人被"认错"了多少回（>1 才显示）。
                 库的大小只跟"撞过脸的陌生人有多少个"有关，与点了多少次认错无关。 -->
            <span class="block-count" v-if="b.count > 1" :title="`同一个人已被认错 ${b.count} 次（已合并为一条）`">
              ×{{ b.count }}
            </span>
            <span class="face-time" v-if="b.at">{{ fmtPendingAt(b.at) }}</span>
            <div class="face-acts">
              <button class="mini-btn ghost" @click="doUnmarkStranger(b)">解除</button>
            </div>
          </div>
        </div>

        <!-- 反例合并阈值：见 vecMatch.blockMergeThreshold 的注释 -->
        <div class="opt" v-if="blockLibOpen">
          <span>
            <strong>同一个人合并阈值</strong>
            <em>
              同一张陌生人脸再次被认错时，相似度高于该值就合并进已有那条（计数 +1），不再新增记录。
              填 0 = 关闭合并，每次认错都单独存一条
            </em>
          </span>
          <div class="range-row">
            <input
              type="range"
              min="0"
              max="0.95"
              step="0.05"
              :value="mergeThresholdShown"
              @input="opts.face.blockMergeThreshold = Number($event.target.value)"
            />
            <b>{{ mergeThresholdShown > 0 ? Number(mergeThresholdShown).toFixed(2) : '关' }}</b>
          </div>
        </div>

        <!-- 反例保留期限（默认 0 = 永不过期）：判定收口在 defaults.blockMaxAgeDays +
             normalizeFaceBlocks 的"时间上限"，与 BLOCK_KEEP"容量上限"是两套独立口径。
             超过 N 天没再被认错的陌生人反例会自动过期剔除，库只留近期还在撞脸的。 -->
        <div class="opt" v-if="blockLibOpen">
          <span>
            <strong>反例保留期限</strong>
            <em>
              超过该天数没再被认错的陌生人反例会自动过期剔除（默认 0 = 永不过期）。
              与上面「最多保留条数」是两套口径：先按过期删，再按容量滚
            </em>
          </span>
          <div class="test-row">
            <input
              class="field mini"
              type="number"
              min="0"
              max="365"
              step="1"
              v-model.number="opts.face.blockMaxAgeDays"
            />
            <span class="unit">天</span>
          </div>
        </div>

        <div class="pending-empty" v-else-if="blockLibOpen">
          <span class="pe-icon" aria-hidden="true">🚫</span>
          <div class="pe-body">
            <strong class="pe-title">还没有陌生人标记</strong>
            <em class="pe-hint">
              在「命中修正」里看到陌生人被认成了某人，点卡片上的「认错」即可标记；之后同一张脸再来会直接走待录入/陌生人路径。
            </em>
          </div>
        </div>
      </div>

      <!-- 人脸库 -->
      <div class="opt col">
        <span>
          <strong>
            人脸库（{{ faceLib.length }} / {{ opts.face.libMax }}）
            <span class="opt-acts">
              <button class="mini-btn ghost" @click="faceLibOpen = !faceLibOpen">
                {{ faceLibOpen ? '收起' : '管理' }}
              </button>
              <button class="mini-btn" @click="triggerEnrollFile" :disabled="enrollState === 'loading'">
                {{ enrollState === 'loading' ? '录入中…' : '上传照片录入' }}
              </button>
              <button
                class="mini-btn ghost"
                :disabled="!mixedGroupNameCount || bulkSplitting"
                :title="mixedGroupNameCount ? `把 ${mixedGroupNameCount} 个混合名卡片按名字拆开` : '当前没有需要拆分的混合名卡片'"
                @click="doBulkSplitAll"
              >
                {{ bulkSplitting ? '拆分中…' : '一键拆分' }}
              </button>
            </span>
          </strong>
          <em>报警推送里显示的就是这里的名字；同一个人的多个角度会归到一张卡片，共用一个名字</em>
        </span>
        <input
          ref="enrollFileEl"
          type="file"
          accept="image/*"
          class="hidden-file"
          @change="onEnrollFile"
        />
        <!-- 上传录入的反馈：明确告诉用户「在干嘛 / 成没成」，不靠静默或 alert -->
        <p class="enroll-status" v-if="enrollState !== 'idle'" :class="enrollState === 'error' ? 'err' : (enrollState === 'done' ? 'ok' : 'busy')">
          {{ enrollMsg }}
        </p>

        <!-- 同一人归类：只在"确实有人占了多条"时才出现（没重复就没什么可归的） -->
        <div class="face-group-toggle" v-if="faceLibOpen && groupedExtra > 0">
          <span class="switch" :class="{ on: groupBySim }" @click="toggleGroupBySim"></span>
          <span>
            <strong>同一人归类显示</strong>
            <em>
              已把同一人的多角度样本并到一张卡片：{{ faceGroups.length }} 人 · {{ faceLib.length }} 条样本。
              判据是「相同名字」或「相似度 ≥ {{ Number(groupThreshold).toFixed(2) }}」（与上面的识别阈值同一个数）。
              觉得并错了就关掉，立刻恢复一张一条。
            </em>
          </span>
        </div>

        <div class="face-grid" v-if="faceLibOpen" ref="libGridEl">
          <div
            class="face-card"
            :class="{ grouped: g.count > 1, selected: selectedGroupKey === g.key }"
            v-for="g in pagedFaceGroups"
            :key="g.key"
          >
            <!-- 缩略图 = 这个人最早录入的那张（代表样本）；设了主样本则用它当封面；多条时可点开看全部角度 -->
            <div
              class="face-thumb"
              :class="{ clickable: g.count > 1 }"
              :title="g.count > 1 ? '点开看这个人的全部角度样本' : ''"
              @click="toggleGroupPanel(g)"
            >
              <img v-if="g.thumb" :src="g.thumb" alt="人脸" />
              <span class="face-count" v-if="g.count > 1">{{ g.count }}</span>
              <!-- 主样本（★）：用户指定的代表样本，只影响封面 / 挑样本基准，不影响匹配 -->
              <span
                class="face-primary-star"
                v-if="g.primaryId"
                title="主样本：这张卡片的封面与挑样本基准都是它（不影响识别匹配）"
                >★</span
              >
              <span
                class="face-warn"
                v-if="g.count > 1 && g.sameName === false"
                title="这一组里有多个名字，推送时会各按各的名字 —— 改名可统一"
                >!</span
              >                  </div>
            <div class="face-rename" v-if="faceRenameKey === g.key">
              <input
                class="field mini"
                v-model.trim="faceRenameText"
                :disabled="renamingFace[g.key]"
                :placeholder="g.name"
                @keyup.enter="commitRenameGroup"
                @blur="commitRenameGroup"
              />
            </div>
            <span class="face-meta" v-else :title="g.name">{{ g.name }}</span>
            <!-- 手动归类（卡级）：把"这个人"整体归入另一个已知的人。
             * 修的是自动归类把同一个人拆成两张卡的情况 —— 选另一个人的名字，
             * 这一整张卡的样本会一起改过去、重新并到那个人那一组。
             * 只在"库里确实有其它人可并"时才出现（没别人可并就没什么可归的）。 -->
            <div class="face-assign" v-if="otherNames(g).length">
              <FaceAssignSelect
                v-model="groupAssign[g.key]"
                :options="otherNames(g)"
                placeholder="归入到…"
                :disabled="assigningGroup[g.key]"
                @change="onGroupAssign(g)"
              />
            </div>
            <div class="face-acts">
              <!-- 保存中：明确的「在干活」反馈 —— 没有它就是用户嘴里的"点了没反应" -->
              <button class="mini-btn face-busy" v-if="renamingFace[g.key]" disabled>保存中</button>
              <template v-else>
                <button class="mini-btn ghost" v-if="!deletingFace[g.key]" @click="startRenameGroup(g)">改名</button>
                <!-- 主样本：多角度时才有得选（单条样本本来就是它自己）。
                     没设过 → 一键把封面样本设为代表；设过 → 点开面板换一张 -->
                <button
                  class="mini-btn ghost primary-btn"
                  v-if="g.count > 1 && !deletingFace[g.key]"
                  :disabled="settingPrimary[g.id]"
                  :title="g.primaryId ? '已设主样本 · 点开面板可更换' : '把封面样本（最早录入那张）设为主样本：卡片封面、挑样本基准都用它'"
                  @click="g.primaryId ? toggleGroupPanel(g) : doSetPrimaryCard(g)"
                >
                  {{ settingPrimary[g.id] ? '设置中' : g.primaryId ? '★ 主样本' : '设为主样本' }}
                </button>
                <button class="mini-btn danger" :disabled="deletingFace[g.key]" @click="doDeleteGroup(g)">{{ deletingFace[g.key] ? '删除中' : '删除' }}</button>
              </template>
            </div>
          </div>
          <p class="hint tight" v-if="!faceLib.length">人脸库还是空的：先让摄像头拍到人，出现的脸会进「待录入」。</p>
        </div>

        <!-- 点开一张「一个人」的卡片：看他的全部角度样本，可合并、可删掉拍歪的那张 -->
        <div class="face-group-panel" v-if="selectedGroup">
          <div class="fgp-head">
            <strong>{{ selectedGroup.name }}</strong>
            <span class="fgp-tag">{{ selectedGroup.count }} 个角度样本</span>
            <span class="fgp-tag warn" v-if="selectedGroup.sameName === false">
              名字不一致 · 最弱一环 {{ simPct(selectedGroup.score) }}
            </span>
            <span class="fgp-tag ok" v-else>同名归为一组</span>
            <span class="fgp-acts">
              <!-- 合并勾选：默认全选，取消勾选可把某些角度排除在合并之外
                   （不同角度全并成一条平均脸会丢角度覆盖，见脚本注释） -->
              <label class="fgp-allcheck" :title="mergeAllChecked ? '全部不选' : '全部选中'">
                <input type="checkbox" :checked="mergeAllChecked" @change="toggleMergeAll" />
                <span>{{ mergeAllChecked ? '全不选' : '全选' }}</span>
              </label>
              <button
                class="mini-btn"
                :disabled="!!mergingGroup || mergeSelCount < 2"
                @click="doMergeGroup(selectedGroup)"
              >
                {{
                  mergingGroup
                    ? '合并中…'
                    : mergeSelCount < selectedGroup.count
                      ? `合并勾选的 ${mergeSelCount} 条`
                      : '合并为一条'
                }}
              </button>
              <button class="mini-btn ghost" @click="selectedGroupKey = ''">收起</button>
            </span>
          </div>
          <div class="fgp-samples">
            <div class="fgp-item" v-for="(it, i) in selectedGroup.items" :key="it.id">
              <label class="fgp-check" :title="mergeSelected.includes(it.id) ? '不参与合并' : '参与合并'">
                <input type="checkbox" :value="it.id" v-model="mergeSelected" />
              </label>
              <img v-if="it.thumb" :src="it.thumb" alt="样本" />
              <span
                class="fgp-sim"
                :class="{ primary: it.primary }"
                :title="it.primary ? '主样本：卡片封面与挑样本基准' : i === 0 ? '代表样本（最早录入的那张）' : '与代表样本的相似度'"
                >{{ it.primary ? '★ 主样本' : i === 0 ? '代表' : simPct(it.sim) }}</span
              >
              <span class="fgp-name" :title="it.name">{{ it.name }}</span>
              <!-- 主样本：这一条当代表（封面 / 挑样本基准）。不影响识别匹配 -->
              <button
                class="mini-btn ghost primary-btn"
                :disabled="settingPrimary[it.id]"
                :title="it.primary ? '取消主样本标记（回到默认：封面取最早录入那张）' : '把这一条设为主样本：卡片封面、挑样本基准都用它'"
                @click="it.primary ? doClearPrimarySample(it) : doSetPrimarySample(it)"
              >
                {{ settingPrimary[it.id] ? '…' : it.primary ? '取消' : '设为主样本' }}
              </button>
              <!-- 手动归入：把这一条样本单独改名到某个人（修自动归类误并的问题） -->
              <div class="fgp-assign">
                <FaceAssignSelect
                  v-model="sampleAssign[it.id]"
                  :options="faceNameOptions"
                  placeholder="归入…"
                  :custom="true"
                  custom-placeholder="自定义名字"
                  custom-confirm-text="确定"
                  :disabled="assigningSample[it.id]"
                  @change="onSampleAssign(it)"
                />
              </div>
              <button class="mini-btn danger" :disabled="deletingSample[it.id]" @click="doDeleteSample(it)">
                {{ deletingSample[it.id] ? '删除中' : '删除' }}
              </button>
            </div>
          </div>
          <!-- 名字这件事必须说透：推送里叫什么，取决于这几条的**名字是否统一** -->
          <p class="hint tight" v-if="selectedGroup.sameName === false">
            这 {{ selectedGroup.count }} 条现在各有各的名字（{{ selectedGroup.names.join(' / ') }}），
            推送会按命中的那条来 —— 也就是同一个人的不同角度可能推出不同名字。
            点卡片上的「改名」统一成一个名字后，不管哪个角度都推这个名字。
            <template v-if="splitNames(selectedGroup).length >= 2">
              <br />
              如果这其实是**两个人**（只是长得像被并到了一起）：用人脸库标题处的「一键拆分（全部不同名）」，
              两人会各自成卡、推送也各叫各的名；拆分后新录入的同名样本同样受保护。
            </template>
          </p>
          <p class="hint tight" v-else>
            这几条同名，推送里都用「{{ selectedGroup.name }}」；改名会一起改。
            勾选想合并的角度样本，点「合并为一条」把它们的特征平均成一条：适合同一角度拍重了的去重、腾名额；
            <b>不同角度的样本建议保持不勾选</b>——识别时是逐条取最高相似度，角度留得全更容易命中。
          </p>
        </div>

        <div class="face-pager" v-if="faceLibOpen && libPageCount > 1">
          <button class="mini-btn ghost" :disabled="libPage <= 1" @click="libPage -= 1">上一页</button>
          <span class="face-page-text">{{ libPage }} / {{ libPageCount }}</span>
          <button class="mini-btn ghost" :disabled="libPage >= libPageCount" @click="libPage += 1">下一页</button>
        </div>
        <div class="face-acts" v-if="faceLibOpen && faceLib.length">
          <button class="mini-btn danger" @click="doClearFaces">清空人脸库</button>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup>
import { inject } from 'vue'

/* 设置抽屉上下文（父级 SettingsDrawer 用 provide('sd', …) 暴露全部状态 / 函数 / emit / props） */
const sd = inject('sd')
const { FACE_DET_SIZES, FaceAssignSelect, allPendingFaces, assigningGroup, assigningSample, backendFaceHits, blockLibOpen, blockMergeThreshold, bulkSplitting, commitRenameGroup, deletingFace, deletingSample, doAddPending, doBulkSplitAll, doClearFaces, doClearPrimarySample, doDeleteGroup, doDeleteSample, doFixHit, doIgnoreAllHits, doIgnoreAllPending, doIgnoreHit, doIgnorePagePending, doIgnorePending, doMarkStranger, doMergeGroup, doSetPrimaryCard, doSetPrimarySample, doUnmarkStranger, emit, enrollFileEl, enrollMsg, enrollState, enrollingPending, faceAttrText, faceBackendOn, faceGroups, faceLib, faceLibOpen, faceNameOptions, faceRenameKey, faceRenameText, faceTuneOpen, fixingHit, fmtPendingAt, gpuReady, gpuText, groupAssign, groupBySim, groupThreshold, groupedExtra, hidden, hitAssign, hitEmpty, hitMarginThreshold, hitRefreshNote, hitRefreshing, hitReviewOpen, libGridEl, libPage, libPageCount, mergeAllChecked, mergeSelCount, mergeSelected, mergeThresholdShown, mergingGroup, mixedGroupNameCount, onEnrollFile, onGroupAssign, onSampleAssign, openPendingShot, opts, otherNames, pagedFaceGroups, pagedPending, pendingAssign, pendingEmpty, pendingGridEl, pendingLibOpen, pendingPage, pendingPageCount, pendingRefreshNote, pendingRefreshing, pendingSort, pfQuality, pfRecommended, pfScoreTip, props, ref, refreshBackendFaceHits, refreshBackendPending, renamingFace, resetFaceTune, sampleAssign, selectedGroup, selectedGroupKey, settingPrimary, simPct, splitNames, startRenameGroup, strangerMarks, toggleGroupBySim, toggleGroupPanel, toggleMergeAll, togglePendingSort, triggerEnrollFile } = sd
const { cameras, options, hiddenIds, layouts, layoutKey, native, events, openTab, tempSilent } = props
</script>
