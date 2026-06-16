export const meta = {
  name: 'best-of-both-worlds',
  description:
    '检查 caozhiyuan/dev -> czy-all -> dev 的集成状态，分析冲突，并在任何写操作前停在明确的用户授权门禁处。',
  phases: [
    {
      title: '检查现状',
      detail: '顺序读取分支、远端、同步状态、PR 与工作树事实，并先刷新远端引用',
    },
    {
      title: '判定阶段',
      detail: '把当前状态归类为工作区阻塞、污染恢复、需要同步、PR 阻塞、可合并或冲突分析',
    },
    {
      title: '总结价值',
      detail: '只在存在 PR 时总结不冲突改动的价值及其对下游用户的影响',
    },
    {
      title: '分析冲突',
      detail: '只在本地已存在 dev <- czy-all 冲突工作区时逐块分析冲突，且按需并行',
    },
    {
      title: '生成门禁',
      detail: '生成逐字授权文案与下一步写操作候选命令',
    },
    {
      title: '返回方案',
      detail: '返回结构化事实、风险、下一步动作、候选命令与停止点',
    },
  ],
}

const repoPath = args?.repoPath || '/home/cpf/code-inside/copilot-api'
const prNumber = args?.prNumber ?? null
const allowLocalConflictAnalysis = args?.allowLocalConflictAnalysis !== false
const maxConflictBlocks = Number.isFinite(args?.maxConflictBlocks) ? args.maxConflictBlocks : 20

const INSPECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'statusShortBranch',
    'currentBranch',
    'branchVv',
    'remotes',
    'czyAllUpstream',
    'aheadBehindLeft',
    'aheadBehindRight',
    'czyAllVsCaozhiyuan',
    'hasPr',
    'prNumber',
    'prUrl',
    'mergeable',
    'mergeStateStatus',
    'reviewDecision',
    'isDraft',
    'headRefOid',
    'prState',
    'failingChecksCount',
    'pendingChecksCount',
    'nonConflictNameOnly',
    'diffStat',
    'localUnmergedPaths',
    'dirtyPaths',
  ],
  properties: {
    statusShortBranch: { type: 'string' },
    currentBranch: { type: 'string' },
    branchVv: { type: 'string' },
    remotes: { type: 'string' },
    czyAllUpstream: { type: 'string' },
    aheadBehindLeft: { type: 'number' },
    aheadBehindRight: { type: 'number' },
    czyAllVsCaozhiyuan: { type: 'string' },
    hasPr: { type: 'boolean' },
    prNumber: { type: 'number' },
    prUrl: { type: 'string' },
    mergeable: { type: 'string' },
    mergeStateStatus: { type: 'string' },
    reviewDecision: { type: 'string' },
    isDraft: { type: 'boolean' },
    headRefOid: { type: 'string' },
    prState: { type: 'string' },
    failingChecksCount: { type: 'number' },
    pendingChecksCount: { type: 'number' },
    nonConflictNameOnly: { type: 'string' },
    diffStat: { type: 'string' },
    localUnmergedPaths: { type: 'array', items: { type: 'string' } },
    dirtyPaths: { type: 'array', items: { type: 'string' } },
  },
}

const CHANGE_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['changes'],
  properties: {
    changes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'value', 'useCase'],
        properties: {
          path: { type: 'string' },
          value: { type: 'string' },
          useCase: { type: 'string' },
        },
      },
    },
  },
}

const BLOCK_ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'file',
    'blockIndex',
    'devIntent',
    'czyAllIntent',
    'recommendedResolution',
    'rationale',
    'risk',
    'needsUserDecision',
    'preflightText',
  ],
  properties: {
    file: { type: 'string' },
    blockIndex: { type: 'number' },
    devIntent: { type: 'array', items: { type: 'string' } },
    czyAllIntent: { type: 'array', items: { type: 'string' } },
    recommendedResolution: { type: 'string' },
    rationale: { type: 'string' },
    risk: { type: 'array', items: { type: 'string' } },
    needsUserDecision: { type: 'boolean' },
    preflightText: { type: 'string' },
  },
}

const SHELL_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['command', 'stdout', 'exitCode'],
  properties: {
    command: { type: 'string' },
    stdout: { type: 'string' },
    exitCode: { type: 'number' },
  },
}

async function inspectRepo() {
  return agent(
    [
      `在仓库 ${repoPath} 中顺序执行下列检查，并在最后一次性返回结构化 JSON。`,
      '要求：',
      '1. 先执行 `git fetch origin --prune` 与 `git fetch caozhiyuan --prune`，再读取其余事实。',
      '2. 不执行 checkout、merge、push、commit、git add、lint --fix。',
      '3. `dirtyPaths` 填 `git status --short --branch` 除第一行外的所有非空行。',
      '4. `localUnmergedPaths` 填 `git diff --name-only --diff-filter=U` 的逐行数组。',
      '5. 若不存在 PR，令 `hasPr=false`，`prNumber=0`，其余 PR 字段给空串或 false 或 0。',
      '6. `prState` 只允许填：missing-pr、blocked-pr、ready-for-merge、conflict。',
      '7. 输出必须严格匹配 schema。',
      '建议执行顺序：',
      'cd 仓库',
      'git fetch origin --prune',
      'git fetch caozhiyuan --prune',
      'git status --short --branch',
      'git rev-parse --abbrev-ref HEAD',
      'git branch -vv',
      'git remote -v',
      'git rev-parse --abbrev-ref czy-all@{upstream}',
      'git rev-list --left-right --count origin/czy-all...czy-all',
      'git log --oneline caozhiyuan/dev..czy-all',
      'gh pr list --base dev --head czy-all --json number,url,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,isDraft,headRefOid,state',
      prNumber
        ? `gh pr view ${prNumber} --json number,url,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,isDraft,headRefOid,state`
        : '若未指定 prNumber，则用 pr list 的第一个结果作为当前 PR；若列表为空则视为无 PR',
      'git diff --name-only --diff-filter=U dev...czy-all',
      'git diff --stat dev...czy-all',
      'git diff --name-only --diff-filter=U',
    ].join('\n'),
    {
      label: '顺序检查仓库现状',
      phase: '检查现状',
      schema: INSPECT_SCHEMA,
      effort: 'low',
    },
  )
}

async function runReadonlyShell(command, label, phaseName) {
  return agent(
    [
      `在仓库 ${repoPath} 内运行只读 shell 命令，并以 JSON 返回结果。`,
      '要求：',
      '1. 只运行给定命令，不追加写操作。',
      '2. 若命令失败，仍返回 exitCode 与 stdout。',
      '3. 输出严格匹配 schema。',
      `命令：cd ${repoPath} && ${command}`,
    ].join('\n'),
    {
      label,
      phase: phaseName,
      schema: SHELL_JSON_SCHEMA,
      effort: 'low',
    },
  )
}

function trim(text) {
  return String(text || '').trim()
}

function lines(text) {
  return trim(text)
    ? trim(text)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    : []
}

function classifyPollution(commits) {
  const suspicious = commits.filter((line) =>
    /(lint|typecheck|build|test|skill|config|cleanup|fix)/i.test(line),
  )
  return {
    polluted: suspicious.length > 0,
    suspiciousCommits: suspicious,
  }
}

function buildCurrentPr(inspect) {
  if (!inspect.hasPr) {
    return null
  }

  return {
    number: inspect.prNumber,
    url: inspect.prUrl,
    mergeable: inspect.mergeable,
    mergeStateStatus: inspect.mergeStateStatus,
    reviewDecision: inspect.reviewDecision,
    isDraft: inspect.isDraft,
    headRefOid: inspect.headRefOid,
    state: inspect.prState,
    failingChecksCount: inspect.failingChecksCount,
    pendingChecksCount: inspect.pendingChecksCount,
  }
}

function buildCandidateCommand(stage, command, reason, requiresApproval = true) {
  return {
    stage,
    command,
    reason,
    writes: true,
    requiresApproval,
  }
}

function buildReadCommand(stage, command, reason) {
  return {
    stage,
    command,
    reason,
    writes: false,
    requiresApproval: false,
  }
}

function buildLocalMergeGate() {
  return {
    kind: 'enter-local-conflict-analysis',
    preflight:
      '确认：你已明确授权我在本地 dev 上执行 `git merge --no-ff --no-commit czy-all` 以生成冲突分析工作区（原话：“...”）。这不包含任何冲突块编辑、删除 marker、git add、验证、commit 或 push 授权。',
  }
}

function buildValidationGate(blocks) {
  const bullets = blocks.length
    ? blocks
        .map((block) => `- 第 ${block.blockIndex} 块（${block.file}）：原话“...”`)
        .join('\n')
    : '- 第 1 块（<file>:<hunk>）：原话“...”'

  return {
    kind: 'project-validation',
    preflight:
      `确认：本次 merge 共 ${blocks.length || 'Y'} 个冲突块，每块的用户拍板原话如下：\n${bullets}\n现在才进入项目级验证。`,
  }
}

function buildCommitPushGate(blocks) {
  return {
    kind: 'commit-push',
    preflight:
      `确认：本次本地 merge \`dev <- czy-all\` 共解决 ${blocks.length || 'Y'} 块冲突，全部用户拍板原话已列出；项目级验证已全绿（lint/build/test/typecheck 均通过）；你已明确授权将合并提交 <sha 或待创建的合并提交> push 到 origin/dev（原话：“...”），现在才执行 commit/push。`,
  }
}

function buildGhMergeGate(pr) {
  const prNumberText = pr?.number ? `#${pr.number}` : '#X'
  const prUrl = pr?.url || '...'
  const headSha = pr?.headRefOid || '...'
  return {
    kind: 'github-merge',
    preflight: `确认：你已明确授权将 PR ${prNumberText} 合并到 dev（URL：${prUrl}，head SHA：${headSha}，原话：”...”），现在才执行。`,
  }
}

function buildPollutionGate(currentRemoteSha, cleanSyncSha, badShaList) {
  return {
    kind: 'force-rewrite-czy-all',
    preflight:
      `确认：你已明确授权将 origin/czy-all 从 ${currentRemoteSha || '<current-remote-sha>'} 回退/重写到 ${cleanSyncSha || '<clean-sync-sha>'}，目的是移除污染提交 ${badShaList?.length ? badShaList.join(', ') : '<bad-sha-list>'}；授权原话：“...”。现在才执行 --force-with-lease。`,
  }
}

function parseConflictBlocks(rawText) {
  const text = String(rawText || '')
  const files = []
  const chunks = text.split('文件: ').slice(1)

  for (const chunk of chunks) {
    const [fileLine, ...rest] = chunk.split('\n')
    const file = trim(fileLine)
    const body = rest.join('\n')
    const blocks = body.split('<<<<<<<<< 冲突块 ').slice(1)

    const parsedBlocks = blocks.map((block) => {
      const [header, ...bodyLines] = block.split('\n')
      const indexMatch = header.match(/(\d+)/)
      const blockIndex = indexMatch ? Number(indexMatch[1]) : 0
      return {
        file,
        blockIndex,
        excerpt: bodyLines.join('\n').trim(),
      }
    })

    files.push(...parsedBlocks)
  }

  return files.filter((item) => item.file && item.blockIndex)
}

phase('检查现状')
log('顺序刷新远端引用并读取仓库现状。')

const inspect = await inspectRepo()
const currentPr = buildCurrentPr(inspect)
const commitsBeyondUpstream = lines(inspect.czyAllVsCaozhiyuan)
const pollution = classifyPollution(commitsBeyondUpstream)

const facts = [
  `当前分支为 ${inspect.currentBranch}（证据：\`git rev-parse --abbrev-ref HEAD\` 返回 \`${inspect.currentBranch}\`）。`,
  `工作树状态摘要为：${trim(inspect.statusShortBranch) || '空'}。`,
  `czy-all upstream 为 ${inspect.czyAllUpstream || 'UNKNOWN'}。`,
  `origin/czy-all 与本地 czy-all 的差异计数为 ${inspect.aheadBehindLeft}/${inspect.aheadBehindRight}。`,
  `caozhiyuan/dev..czy-all 的提交列表为：${trim(inspect.czyAllVsCaozhiyuan) || '空'}。`,
  inspect.hasPr
    ? `当前识别到 PR #${inspect.prNumber}，mergeable=${inspect.mergeable || 'UNKNOWN'}，mergeStateStatus=${inspect.mergeStateStatus || 'UNKNOWN'}。`
    : '当前未识别到现成的 czy-all -> dev PR。',
]

if (inspect.dirtyPaths.length > 0) {
  facts.push(`工作树存在 ${inspect.dirtyPaths.length} 条非干净项：${inspect.dirtyPaths.join('；')}。`)
}

if (inspect.localUnmergedPaths.length > 0) {
  facts.push(`当前本地存在 ${inspect.localUnmergedPaths.length} 个未合并路径：${inspect.localUnmergedPaths.join('、')}。`)
}

phase('判定阶段')
log('按 preflight 规则优先判断阻塞条件。')

let stage = 'blocked'
let summary = ''
let nonConflictChanges = []
let conflicts = []
const risks = []
const nextActions = []
const candidateCommands = []
const gates = []

if (inspect.dirtyPaths.length > 0) {
  stage = 'blocked'
  summary = '工作树不干净；按 preflight 规则必须先停住，不进入同步或 PR 结论。'
  risks.push('若在脏工作树上继续 checkout/merge/push，可能把无关改动卷入 best-of-both-worlds 流程。')
  nextActions.push('先让用户决定如何处理当前工作树改动，再重新运行 workflow。')
  candidateCommands.push(
    buildReadCommand(
      'blocked',
      'git status --short --branch',
      '重新展示当前工作树脏状态，供用户决定是否清理、暂存或保留',
    ),
  )
} else if (inspect.currentBranch !== 'dev') {
  stage = 'blocked'
  summary = `当前分支不是 dev，而是 ${inspect.currentBranch}；按 skill 流程必须先停住说明。`
  risks.push('若不在 dev 上继续流程，后续 PR 判断与本地冲突分析方向可能错误。')
  nextActions.push('先向用户报告当前不在 dev，再等待用户决定是否切回。')
} else if (inspect.czyAllUpstream !== 'origin/czy-all') {
  stage = 'blocked'
  summary = 'czy-all upstream 不是 origin/czy-all；按 skill 规则必须先停住说明。'
  risks.push('若擅自改 tracking，可能破坏 buffer 分支语义。')
  nextActions.push('向用户报告 czy-all tracking 异常；不要自动修。')
} else if (pollution.polluted) {
  stage = 'pollution-recovery'
  summary = '检测到 czy-all 疑似已被本地修复提交污染。'
  risks.push('继续同步或开 PR 会把 buffer 分支污染带入 dev。')
  gates.push(buildPollutionGate('origin/czy-all', '<clean-sync-sha>', pollution.suspiciousCommits))
  candidateCommands.push(
    buildReadCommand(
      'pollution-recovery',
      'git log --first-parent --oneline czy-all -n 20 && git show --stat <candidate-sha> && git show --no-patch --pretty=%P <candidate-sha>',
      '查找最后一个干净同步点候选',
    ),
  )
  candidateCommands.push(
    buildCandidateCommand(
      'pollution-recovery',
      'git checkout czy-all && git reset --hard <clean-sync-commit> && git push --force-with-lease origin czy-all',
      '在用户明确授权后移除污染提交并恢复 buffer 分支语义',
    ),
  )
  nextActions.push('先找干净同步点，再向用户申请 force-with-lease 授权。')
} else if (!inspect.hasPr) {
  stage = 'sync-buffer'
  summary = '未发现现成 czy-all -> dev PR；应先判断是否需要同步 buffer，再创建 PR。'
  candidateCommands.push(
    buildReadCommand(
      'sync-buffer',
      'git status --short --branch && git log --oneline caozhiyuan/dev..czy-all && git rev-list --left-right --count origin/czy-all...czy-all',
      '再次确认工作树、污染与本地/远端差异',
    ),
  )
  candidateCommands.push(
    buildCandidateCommand(
      'sync-buffer',
      'git checkout czy-all && git merge --ff-only caozhiyuan/dev',
      '将上游最新内容以 fast-forward 方式带入 czy-all（fetch 已在检查阶段完成）',
    ),
  )
  candidateCommands.push(
    buildCandidateCommand(
      'sync-buffer',
      'git push origin czy-all && git checkout dev && gh pr create --base dev --head czy-all',
      '推送 buffer 分支并创建 czy-all -> dev PR',
    ),
  )
  nextActions.push('若 fast-forward 不可用，只建议纯同步 merge commit；不要自动执行。')
} else if (inspect.prState === 'ready-for-merge') {
  stage = 'ready-for-merge'
  summary = 'PR 已存在，且当前看起来无冲突、无阻塞，可进入最终 merge 授权阶段。'
  gates.push(buildGhMergeGate(currentPr))
  candidateCommands.push(
    buildReadCommand(
      'ready-for-merge',
      `gh pr view ${inspect.prNumber} --json mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,isDraft,headRefOid,url`,
      '执行最终 merge 前再次确认 PR 状态没有变化',
    ),
  )
  candidateCommands.push(
    buildCandidateCommand(
      'ready-for-merge',
      `gh pr merge ${inspect.prNumber} --merge`,
      '在用户明确授权后完成 GitHub merge',
    ),
  )
  nextActions.push('先向用户汇报 PR 已可合并，再等待最终 merge 授权。')
} else if (inspect.prState === 'blocked-pr') {
  stage = 'blocked'
  summary = 'PR 已存在，但仍被草稿状态、评审、检查项或未知可合并状态阻塞。'
  if (inspect.isDraft) {
    risks.push('PR 仍是 draft。')
  }
  if (inspect.failingChecksCount > 0) {
    risks.push(`存在失败检查项：${inspect.failingChecksCount} 项。`)
  }
  if (inspect.pendingChecksCount > 0) {
    risks.push(`存在等待中检查项：${inspect.pendingChecksCount} 项。`)
  }
  if (trim(inspect.reviewDecision)) {
    risks.push(`reviewDecision 阻塞：${inspect.reviewDecision}`)
  }
  nextActions.push('向用户报告具体阻塞项；不要误报“已完成”。')
} else if (inspect.prState === 'conflict') {
  stage = 'conflict-analysis'
  summary = 'PR 已存在且有冲突；若未来要继续，只能在本地 dev <- czy-all 冲突分析工作区逐块决策。'
  gates.push(buildLocalMergeGate())
  nextActions.push('先向用户申请进入本地冲突分析工作区的授权。')

  if (!allowLocalConflictAnalysis) {
    risks.push('当前参数禁止本地冲突分析；只返回门禁与候选命令。')
    candidateCommands.push(
      buildCandidateCommand(
        'conflict-analysis',
        'git checkout dev && git merge --no-ff --no-commit czy-all',
        '在用户明确授权后创建本地冲突分析工作区',
      ),
    )
  }
} else {
  stage = 'blocked'
  summary = '未能判定明确阶段；保守起见先停住。'
  risks.push('PR 状态或本地事实不完整，继续动作可能误判。')
}

phase('总结价值')
log('只在存在 PR 时总结不冲突改动价值。')

if (inspect.hasPr && trim(inspect.diffStat)) {
  const nonConflictPrompt = [
    '基于下面的 diff stat 与文件列表，总结不冲突改动对用户/使用场景的价值。',
    '若信息不足，就只根据文件名与统计做保守判断，并明确保持保守。',
    '输出 0-8 项。',
    `git diff --stat dev...czy-all:\n${inspect.diffStat}`,
    `git diff --name-only --diff-filter=U dev...czy-all:\n${inspect.nonConflictNameOnly}`,
  ].join('\n\n')

  const nonConflictSummary = await agent(nonConflictPrompt, {
    label: '不冲突改动总结',
    phase: '总结价值',
    schema: CHANGE_SUMMARY_SCHEMA,
    effort: 'low',
  })

  nonConflictChanges = nonConflictSummary.changes
}

phase('分析冲突')
log('只在真实本地冲突工作区存在时才分析冲突块。')

if (stage === 'conflict-analysis') {
  const localConflictWorkspaceExists =
    inspect.localUnmergedPaths.length > 0 && inspect.currentBranch === 'dev' && allowLocalConflictAnalysis

  if (!localConflictWorkspaceExists) {
    risks.push('当前未检测到已存在的本地冲突工作区；无法直接逐块分析真实冲突标记。')
    candidateCommands.push(
      buildCandidateCommand(
        'conflict-analysis',
        'git checkout dev && git merge --no-ff --no-commit czy-all',
        '在用户明确授权后创建本地冲突分析工作区，再重新运行本 workflow',
      ),
    )
  } else {
    const conflictCapture = await runReadonlyShell(
      "for f in $(git diff --name-only --diff-filter=U | head -n 20); do echo \"文件: $f\"; awk 'BEGIN{n=0;inb=0} /^<<<<<<< /{n++; inb=1; print \"<<<<<<<<< 冲突块 \" n; print; next} inb{print} /^>>>>>>> /{inb=0; print; next}' \"$f\"; echo; done",
      '抓取冲突块',
      '分析冲突',
    )

    const parsedBlocks = parseConflictBlocks(conflictCapture.stdout).slice(0, maxConflictBlocks)

    if (parsedBlocks.length <= 3) {
      const sequentialResults = []
      for (const block of parsedBlocks) {
        const result = await agent(
          [
            '你在分析 best-of-both-worlds 冲突块。只做分析，不做编辑。',
            '必须输出：dev 意图、czy-all 意图、推荐组合、理由、风险。',
            '固定 needsUserDecision=true。',
            '固定 preflightText 使用当前块编号。',
            `文件：${block.file}`,
            `块编号：${block.blockIndex}`,
            `冲突内容：\n${block.excerpt}`,
          ].join('\n\n'),
          {
            label: `冲突分析:${block.file}#${block.blockIndex}`,
            phase: '分析冲突',
            schema: BLOCK_ANALYSIS_SCHEMA,
            effort: 'low',
          },
        )
        sequentialResults.push(result)
      }
      conflicts = sequentialResults.filter(Boolean)
    } else {
      conflicts = (
        await parallel(
          parsedBlocks.map((block) => () =>
            agent(
              [
                '你在分析 best-of-both-worlds 冲突块。只做分析，不做编辑。',
                '必须输出：dev 意图、czy-all 意图、推荐组合、理由、风险。',
                '固定 needsUserDecision=true。',
                '固定 preflightText 使用当前块编号。',
                `文件：${block.file}`,
                `块编号：${block.blockIndex}`,
                `冲突内容：\n${block.excerpt}`,
              ].join('\n\n'),
              {
                label: `冲突分析:${block.file}#${block.blockIndex}`,
                phase: '分析冲突',
                schema: BLOCK_ANALYSIS_SCHEMA,
                effort: 'low',
              },
            ),
          ),
        )
      ).filter(Boolean)
    }

    gates.push(
      ...conflicts.map((block) => ({
        kind: 'per-block-approval',
        file: block.file,
        blockIndex: block.blockIndex,
        preflight: block.preflightText,
      })),
    )
  }
}

phase('生成门禁')
log('在任何写操作前生成授权门禁与停止点。')

if (conflicts.length > 0) {
  gates.push(buildValidationGate(conflicts))
  gates.push(buildCommitPushGate(conflicts))
  candidateCommands.push(
    buildReadCommand(
      'project-validation',
      'git rev-parse --abbrev-ref HEAD && git status --short',
      '在进入项目级验证前确认仍位于 dev，且 staged/unmerged 状态可解释',
    ),
  )
  candidateCommands.push(
    buildCandidateCommand(
      'project-validation',
      'bun run lint:all --fix && bun run build && bun test && bun run typecheck',
      '在所有冲突块均获用户拍板后进入项目级验证',
    ),
  )
  candidateCommands.push(
    buildCandidateCommand(
      'commit-push',
      'git commit && git push origin dev',
      '在验证全绿且用户明确授权后提交并推送 dev',
    ),
  )
}

phase('返回方案')
log('返回结构化方案，不执行任何写操作。')

return {
  repoPath,
  prNumber,
  stage,
  summary,
  facts,
  branch: {
    currentBranch: inspect.currentBranch,
    czyAllUpstream: inspect.czyAllUpstream,
    aheadBehind: {
      left: inspect.aheadBehindLeft,
      right: inspect.aheadBehindRight,
    },
  },
  pr: currentPr,
  nonConflictChanges,
  conflicts,
  gates,
  candidateCommands,
  nextActions,
  risks,
  notes: [
    '此 workflow 设计为到写操作门禁即停；candidateCommands 只作建议，不应在无用户授权时执行。',
    '检查现状阶段已顺序执行 fetch，以减少本地陈旧引用导致的误判。',
    '若要逐块分析真实冲突，最好先由用户明确授权并建立本地 dev <- czy-all conflict workspace，再重跑本 workflow。',
    'czy-all 只应承载上游同步结果；检测到污染时应优先进入污染恢复路径。',
  ],
}
