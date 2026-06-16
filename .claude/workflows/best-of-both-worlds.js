export const meta = {
  name: 'best-of-both-worlds',
  description:
    '按 best-of-both-worlds skill 自动推进 caozhiyuan/dev -> czy-all -> dev 集成，在不 commit dev、不 push dev 前提下停在最终人工审阅处。',
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
      detail: '在 PR 冲突时自动进入本地 dev <- czy-all 集成工作区，逐文件解决冲突并整理 best-of-both-worlds 摘要',
    },
    {
      title: '执行同步',
      detail: '在 workflow 内部执行 czy-all 同步、push，并回切到 dev',
    },
    {
      title: '检查 PR 状态',
      detail: '创建或确认 czy-all -> dev PR，并继续读取 merge/check/review 状态',
    },
    {
      title: '生成门禁',
      detail: '运行验证并整理最终人工审阅停点；只为最终 merge 或污染恢复保留明确授权门禁',
    },
    {
      title: '返回方案',
      detail: '返回结构化事实、风险、下一步动作、候选命令与当前停点',
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

const FILE_RESOLUTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'resolvedAllBlocks', 'staged', 'blockReports'],
  properties: {
    file: { type: 'string' },
    resolvedAllBlocks: { type: 'boolean' },
    staged: { type: 'boolean' },
    blockReports: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'blockIndex',
          'devIntent',
          'czyAllIntent',
          'resolvedAs',
          'whyBestOfBoth',
          'featureImpact',
          'risk',
        ],
        properties: {
          blockIndex: { type: 'number' },
          devIntent: { type: 'array', items: { type: 'string' } },
          czyAllIntent: { type: 'array', items: { type: 'string' } },
          resolvedAs: { type: 'string' },
          whyBestOfBoth: { type: 'string' },
          featureImpact: { type: 'array', items: { type: 'string' } },
          risk: { type: 'array', items: { type: 'string' } },
        },
      },
    },
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

async function runShell(command, label, phaseName, mode = '只读') {
  return agent(
    [
      `在仓库 ${repoPath} 内运行 ${mode} shell 命令，并以 JSON 返回结果。`,
      '要求：',
      '1. 只运行给定命令，不额外追加未写出的命令。',
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

async function runReadonlyShell(command, label, phaseName) {
  return runShell(command, label, phaseName, '只读')
}

async function runWritableShell(command, label, phaseName) {
  return runShell(command, label, phaseName, '写操作')
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

function normalizeDirtyPaths(dirtyPaths) {
  return lines((dirtyPaths || []).join('\n')).filter(
    (line) => !/^clean\s+[—-]\s+nothing to commit\.?$/i.test(line),
  )
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

function buildFinalUserReviewGate(blocks) {
  return {
    kind: 'final-review-before-dev-commit',
    preflight:
      `确认：workflow 已自动完成本地 dev <- czy-all 集成、冲突解决与必要验证；当前共整理 ${blocks.length || 'Y'} 个冲突块的解决摘要，并且尚未 commit 或 push dev。请先审阅每块冲突如何解决、为何是 best of both、以及功能/使用场景影响，再决定是否继续由 main agent 执行 commit/push。`,
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

function groupConflictBlocks(blocks) {
  const grouped = new Map()

  for (const block of blocks) {
    const current = grouped.get(block.file) || []
    current.push(block)
    grouped.set(block.file, current)
  }

  return Array.from(grouped.entries()).map(([file, fileBlocks]) => ({
    file,
    blocks: fileBlocks.sort((a, b) => a.blockIndex - b.blockIndex),
  }))
}

phase('检查现状')
log('顺序刷新远端引用并读取仓库现状。')

const inspect = await inspectRepo()
const dirtyPaths = normalizeDirtyPaths(inspect.dirtyPaths)
let resultInspect = inspect
let currentPr = buildCurrentPr(inspect)
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

if (dirtyPaths.length > 0) {
  facts.push(`工作树存在 ${dirtyPaths.length} 条非干净项：${dirtyPaths.join('；')}。`)
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
let resolvedConflictBlocks = []
let validationResult = null
const risks = []
const nextActions = []
const candidateCommands = []
const gates = []

if (dirtyPaths.length > 0) {
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
  summary = '当前未发现现成 czy-all -> dev PR；workflow 将按 skill 镜像执行 sync-buffer 主链。'

  phase('执行同步')
  log('在 workflow 内执行 czy-all 同步、push，并回切到 dev。')

  const syncResult = await runWritableShell(
    [
      'git checkout czy-all',
      'git fetch caozhiyuan --prune',
      'git fetch origin --prune',
      'if git merge --ff-only caozhiyuan/dev; then',
      '  echo sync-mode:ff-only',
      'else',
      '  git merge --no-ff --no-edit caozhiyuan/dev',
      'fi',
      'git log --oneline caozhiyuan/dev..czy-all',
      'git push origin czy-all',
      'git checkout dev',
    ].join('\n'),
    '执行 sync-buffer 主链',
    '执行同步',
  )

  if (syncResult.exitCode !== 0) {
    stage = 'blocked'
    summary = 'sync-buffer 主链执行失败；workflow 已停止。'
    risks.push('workflow 在同步 czy-all 或回切 dev 时失败；继续盲目创建 PR 可能掩盖真实 git 状态。')
    facts.push(`sync-buffer 命令失败（exitCode=${syncResult.exitCode}）：${trim(syncResult.stdout) || 'stdout 为空'}。`)
    candidateCommands.push(
      buildReadCommand(
        'blocked',
        'git status --short --branch && git rev-parse --abbrev-ref HEAD && git log --oneline -1 czy-all && git log --oneline -1 origin/czy-all',
        '重新确认同步失败后的分支、工作树与 czy-all 状态',
      ),
    )
    nextActions.push('先检查 sync-buffer 失败位置，再决定是否重试或人工处理。')
  } else {
    facts.push('workflow 已在内部完成 `git checkout czy-all`、同步 `caozhiyuan/dev`、`git push origin czy-all` 与 `git checkout dev`。')

    phase('检查 PR 状态')
    log('创建或确认 PR，并立即读取 merge/check/review 状态。')

    const ensurePr = await runWritableShell(
      [
        'existing="$(gh pr list --base dev --head czy-all --json number --jq \'.[0].number\')"',
        'if [ -n "$existing" ] && [ "$existing" != "null" ]; then',
        '  echo "existing:$existing"',
        'else',
        '  gh pr create --base dev --head czy-all --fill',
        'fi',
      ].join('\n'),
      '创建或确认 czy-all -> dev PR',
      '检查 PR 状态',
    )

    if (ensurePr.exitCode !== 0) {
      stage = 'blocked'
      summary = 'sync-buffer 已完成，但创建或确认 PR 失败；workflow 已停止。'
      risks.push('若在 PR 创建失败时继续假定 PR 已存在，后续 merge/check 判断会失真。')
      facts.push(`PR 创建/确认失败（exitCode=${ensurePr.exitCode}）：${trim(ensurePr.stdout) || 'stdout 为空'}。`)
      candidateCommands.push(
        buildReadCommand(
          'blocked',
          'gh pr list --base dev --head czy-all --json number,url,mergeable,mergeStateStatus,isDraft,headRefOid,state',
          '检查是否已有 PR 或查看创建失败后的 PR 状态',
        ),
      )
      nextActions.push('先修复 gh pr create 阶段的问题，再决定是否重试。')
    } else {
      const refreshedInspect = await inspectRepo()
      resultInspect = refreshedInspect
      currentPr = buildCurrentPr(refreshedInspect)
      facts.push(
        `刷新后工作树状态为：${trim(refreshedInspect.statusShortBranch) || '空'}。`,
      )
      facts.push(
        refreshedInspect.hasPr
          ? `workflow 已创建或确认 PR #${refreshedInspect.prNumber}（${refreshedInspect.prUrl || '无 URL'}）。`
          : 'workflow 已执行 PR 创建/确认命令，但刷新后仍未识别到 czy-all -> dev PR。',
      )

      if (!refreshedInspect.hasPr) {
        stage = 'blocked'
        summary = 'sync-buffer 已完成，但刷新后仍未识别到 PR；workflow 已停止。'
        risks.push('PR 创建命令可能未生效，或 gh 读取状态失败。')
        nextActions.push('先检查 GitHub 侧 PR 是否实际存在，再决定是否重试。')
      } else if (refreshedInspect.prState === 'ready-for-merge') {
        stage = 'ready-for-merge'
        summary = 'PR 已存在，且当前看起来无冲突、无阻塞，可进入最终 merge 授权阶段。'
        gates.push(buildGhMergeGate(currentPr))
        candidateCommands.push(
          buildReadCommand(
            'ready-for-merge',
            `gh pr view ${refreshedInspect.prNumber} --json mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,isDraft,headRefOid,url`,
            '执行最终 merge 前再次确认 PR 状态没有变化',
          ),
        )
        candidateCommands.push(
          buildCandidateCommand(
            'ready-for-merge',
            `gh pr merge ${refreshedInspect.prNumber} --merge`,
            '在用户明确授权后完成 GitHub merge',
          ),
        )
        nextActions.push('先向用户汇报 PR 已可合并，再等待最终 merge 授权。')
      } else if (refreshedInspect.prState === 'blocked-pr') {
        stage = 'blocked'
        summary = 'PR 已存在，但仍被草稿状态、评审、检查项或未知可合并状态阻塞。'
        if (refreshedInspect.isDraft) {
          risks.push('PR 仍是 draft。')
        }
        if (refreshedInspect.failingChecksCount > 0) {
          risks.push(`存在失败检查项：${refreshedInspect.failingChecksCount} 项。`)
        }
        if (refreshedInspect.pendingChecksCount > 0) {
          risks.push(`存在等待中检查项：${refreshedInspect.pendingChecksCount} 项。`)
        }
        if (trim(refreshedInspect.reviewDecision)) {
          risks.push(`reviewDecision 阻塞：${refreshedInspect.reviewDecision}`)
        }
        candidateCommands.push(
          buildReadCommand(
            'blocked',
            `gh pr view ${refreshedInspect.prNumber} --json mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,isDraft,headRefOid,url`,
            '重新检查 PR 的 merge/check/review 阻塞项',
          ),
        )
        nextActions.push('向用户报告具体阻塞项；不要把“已开 PR”误报成“已完成”。')
      } else if (refreshedInspect.prState === 'conflict') {
        stage = 'conflict-analysis'
        summary = 'PR 已存在且有冲突；workflow 将进入本地 dev <- czy-all 集成工作区，并自动尝试解到最终人工审阅前。'
        nextActions.push('若自动解决成功，workflow 会在不 commit dev、不 push dev 的前提下，整理每个冲突块的解决摘要后停住。')

        if (!allowLocalConflictAnalysis) {
          risks.push('当前参数禁止本地冲突分析；只返回候选命令，不自动进入本地冲突工作区。')
          candidateCommands.push(
            buildCandidateCommand(
              'conflict-analysis',
              'git checkout dev && git merge --no-ff --no-commit czy-all',
              '在显式允许本地冲突分析后创建本地冲突工作区',
            ),
          )
        }
      } else {
        stage = 'blocked'
        summary = 'PR 已存在，但 workflow 未能判定下一阶段；保守起见先停住。'
        risks.push('GitHub PR 状态不完整，继续动作可能误判。')
      }
    }
  }
}
phase('总结价值')
log('只在存在 PR 时总结不冲突改动价值。')

if (resultInspect.hasPr && trim(resultInspect.diffStat)) {
  const nonConflictPrompt = [
    '基于下面的 diff stat 与文件列表，总结不冲突改动对用户/使用场景的价值。',
    '若信息不足，就只根据文件名与统计做保守判断，并明确保持保守。',
    '输出 0-8 项。',
    `git diff --stat dev...czy-all:\n${resultInspect.diffStat}`,
    `git diff --name-only --diff-filter=U dev...czy-all:\n${resultInspect.nonConflictNameOnly}`,
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
log('在冲突场景下进入本地 dev <- czy-all 集成工作区，并尝试自动解到最终人工审阅前一刻。')

if (stage === 'conflict-analysis') {
  let localConflictWorkspaceExists =
    resultInspect.localUnmergedPaths.length > 0 && resultInspect.currentBranch === 'dev' && allowLocalConflictAnalysis

  if (!localConflictWorkspaceExists) {
    const enterConflictWorkspace = await runWritableShell(
      ['git checkout dev', 'git merge --no-ff --no-commit czy-all'].join('\n'),
      '进入本地冲突分析工作区',
      '分析冲突',
    )

    if (enterConflictWorkspace.exitCode !== 0) {
      const refreshedInspect = await inspectRepo()
      resultInspect = refreshedInspect
      currentPr = buildCurrentPr(refreshedInspect)
      localConflictWorkspaceExists =
        refreshedInspect.localUnmergedPaths.length > 0 && refreshedInspect.currentBranch === 'dev'

      if (!localConflictWorkspaceExists) {
        stage = 'blocked'
        summary = 'workflow 尝试进入本地冲突工作区失败，且未检测到可继续的冲突现场。'
        risks.push('若 merge --no-ff --no-commit 失败且未留下可解释的冲突现场，继续自动解冲突会误判。')
        facts.push(
          `进入本地冲突工作区失败（exitCode=${enterConflictWorkspace.exitCode}）：${trim(enterConflictWorkspace.stdout) || 'stdout 为空'}。`,
        )
        candidateCommands.push(
          buildReadCommand(
            'blocked',
            `git status --short --branch && git rev-parse --abbrev-ref HEAD && gh pr view ${prNumber || currentPr?.number || '<number>'} --json mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,isDraft,headRefOid,url`,
            '重新确认本地 merge 失败后的 git 状态与 PR 状态',
          ),
        )
        nextActions.push('先检查为何本地 merge 未形成冲突工作区，再决定是否继续自动化路径。')
      }
    } else {
      facts.push('workflow 已自动进入本地 dev <- czy-all 冲突分析工作区。')
      const refreshedInspect = await inspectRepo()
      resultInspect = refreshedInspect
      currentPr = buildCurrentPr(refreshedInspect)
      localConflictWorkspaceExists =
        refreshedInspect.localUnmergedPaths.length > 0 && refreshedInspect.currentBranch === 'dev'
    }
  }

  if (stage === 'conflict-analysis' && localConflictWorkspaceExists) {
    const conflictCapture = await runReadonlyShell(
      "for f in $(git diff --name-only --diff-filter=U | head -n 20); do echo \"文件: $f\"; awk 'BEGIN{n=0;inb=0} /^<<<<<<< /{n++; inb=1; print \"<<<<<<<<< 冲突块 \" n; print; next} inb{print} /^>>>>>>> /{inb=0; print; next}' \"$f\"; echo; done",
      '抓取冲突块',
      '分析冲突',
    )

    const parsedBlocks = parseConflictBlocks(conflictCapture.stdout).slice(0, maxConflictBlocks)
    conflicts = parsedBlocks

    if (parsedBlocks.length === 0) {
      stage = 'blocked'
      summary = 'PR 标记为冲突，但本地冲突工作区未抓到 conflict marker。'
      risks.push('GitHub PR 状态与本地 merge 现场不一致；继续自动解冲突会误判。')
      nextActions.push('先复核 PR 状态与本地 merge 结果是否一致，再决定是否重试。')
    } else {
      facts.push(`当前共有 ${groupConflictBlocks(parsedBlocks).length} 个冲突文件、${parsedBlocks.length} 个冲突块。`)
      const groupedFiles = groupConflictBlocks(parsedBlocks)
      const fileResolutionReports = []

      for (const entry of groupedFiles) {
        const resolution = await agent(
          [
            '你在执行 best-of-both-worlds 自动冲突解决。',
            '目标：在当前本地文件上直接落地冲突解决结果，但不要 commit，不要 push。',
            '你必须先理解每个冲突块的 dev 意图、czy-all 意图，再生成 best-of-both-worlds 结果。',
            '要求：',
            '1. 直接编辑该文件，消除所有 conflict marker。',
            '2. 完成后执行 `git add -- <file>`，但不要 `git add .`。',
            '3. 输出严格匹配 schema。',
            '4. blockReports 中每块都必须说明：如何解决、为何是 best of both、feature/行为/用户场景影响、风险。',
            '5. 若无法安全自动解决，resolvedAllBlocks=false，staged=false，并在 blockReports 里清楚写风险。',
            `文件：${entry.file}`,
            `冲突块总数：${entry.blocks.length}`,
            `冲突块内容：\n${entry.blocks.map((block) => `#${block.blockIndex}\n${block.excerpt}`).join('\n\n')}`,
          ].join('\n\n'),
          {
            label: `自动解冲突:${entry.file}`,
            phase: '分析冲突',
            schema: FILE_RESOLUTION_SCHEMA,
            effort: 'high',
          },
        )
        fileResolutionReports.push(resolution)
      }

      resolvedConflictBlocks = fileResolutionReports.flatMap((item) =>
        item.blockReports.map((block) => ({ file: item.file, ...block })),
      )

      const unresolvedFiles = fileResolutionReports.filter((item) => !item.resolvedAllBlocks || !item.staged)
      if (unresolvedFiles.length > 0) {
        stage = 'blocked'
        summary = 'workflow 已尝试自动解冲突，但仍有文件未安全完成。'
        risks.push(`仍有 ${unresolvedFiles.length} 个冲突文件未完成自动解决或未成功 staged。`)
        nextActions.push('先审阅未完成文件的 blockReports，再决定是否继续人工处理。')
      } else {
        stage = 'final-review-before-dev-commit'
        summary = 'workflow 已自动完成本地冲突解决，并停在 commit/push dev 之前等待最终人工审阅。'
        gates.push(buildFinalUserReviewGate(resolvedConflictBlocks))

        phase('生成门禁')
        log('冲突已自动解决；现在运行验证并停在最终人工审阅前。')

        validationResult = await runWritableShell(
          ['bun run lint:all --fix', 'bun run build', 'bun test', 'bun run typecheck'].join('\n'),
          '执行项目级验证',
          '生成门禁',
        )

        facts.push('workflow 已在本地 dev <- czy-all 集成工作区中自动解决全部检测到的冲突块。')

        if (validationResult.exitCode === 0) {
          facts.push('workflow 已完成 lint/build/test/typecheck，且验证命令 exitCode=0。')
        } else {
          risks.push('自动冲突解决后项目级验证未全绿；已停止在最终人工审阅前。')
          facts.push(
            `项目级验证失败（exitCode=${validationResult.exitCode}）：${trim(validationResult.stdout) || 'stdout 为空'}。`,
          )
        }

        candidateCommands.push(
          buildReadCommand(
            'final-review-before-dev-commit',
            'git status --short && git diff --cached --stat && git diff --cached',
            '审阅自动冲突解决后的 staged 结果与最终改动概览',
          ),
        )
        candidateCommands.push(
          buildCandidateCommand(
            'commit-push',
            'git commit && git push origin dev',
            '仅在用户与 main agent 审阅所有冲突解决摘要后，才继续 commit/push dev',
          ),
        )
        nextActions.push('先审阅每个冲突块的解决摘要、功能影响与风险；确认后再由 main agent 决定是否 commit/push dev。')
      }
    }
  }
}

phase('返回方案')
log('返回结构化方案，不执行 commit 或 push dev。')

return {
  repoPath,
  prNumber,
  stage,
  summary,
  facts,
  branch: {
    currentBranch: resultInspect.currentBranch,
    czyAllUpstream: resultInspect.czyAllUpstream,
    aheadBehind: {
      left: resultInspect.aheadBehindLeft,
      right: resultInspect.aheadBehindRight,
    },
  },
  pr: currentPr,
  nonConflictChanges,
  conflicts,
  resolvedConflictBlocks,
  validation: validationResult
    ? {
        exitCode: validationResult.exitCode,
        stdout: trim(validationResult.stdout),
      }
    : null,
  gates,
  candidateCommands,
  nextActions,
  risks,
  notes: [
    '此 workflow 现在按 best-of-both-worlds skill 的主链执行 sync-buffer、PR 创建/确认，以及必要时的本地 dev <- czy-all 自动集成。',
    'workflow 可以自动尝试解决冲突并运行验证，但不会 commit dev，也不会 push dev。',
    '最终交付给用户与 main agent 的重点，是每个冲突块如何解决、为何是 best of both，以及对应功能/使用场景影响。',
    'czy-all 只应承载上游同步结果；检测到污染时应优先进入污染恢复路径。',
  ],
}
