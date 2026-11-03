import { describe, expect, it } from 'vitest'
import {
  chunkIntersection,
  demoteHeadings,
  isSameTopic,
  isSignpostText,
  stripSignpostSections,
  textChunks,
} from '../src/consolidation-dedupe.ts'

describe('textChunks', () => {
  it('ASCII 段按 [a-z0-9]+ 切分，CJK 段产出 bigram', () => {
    const chunks = textChunks('dsh-ops 记忆')
    expect(chunks.has('dsh')).toBe(true)
    expect(chunks.has('ops')).toBe(true)
    expect(chunks.has('记忆')).toBe(true)
    expect(chunks.has('dsh-ops')).toBe(false)
  })

  it('单字 CJK 段产出该字本身，重复词块去重', () => {
    const chunks = textChunks('梦')
    expect(chunks.has('梦')).toBe(true)
    expect(textChunks('记忆 记忆').size).toBe(1)
  })
})

describe('chunkIntersection', () => {
  it('返回两个词块集合交集的大小', () => {
    const a = textChunks('dsh-ops 插件重装')
    const b = textChunks('dsh-ops 插件重装完成，runtime 齐全')
    expect(chunkIntersection(a, b)).toBeGreaterThanOrEqual(3)
  })
})

describe('isSignpostText', () => {
  it('短文本含指路牌特征 → true', () => {
    expect(isSignpostText('详见 memory/dsh-ops-removal.md。记录日期 2026-11-03。')).toBe(true)
  })

  it('无指路牌特征 → false', () => {
    expect(isSignpostText('dsh-ops 插件重装记录，全部验证步骤都在这里。')).toBe(false)
  })

  it('超长文本即使含特征也不是指路牌', () => {
    const long = `详见全文。${'内容'.repeat(500)}`
    expect(long.length).toBeGreaterThan(900)
    expect(isSignpostText(long)).toBe(false)
  })
})

describe('isSameTopic', () => {
  it('同主题：短摘要的词块大半包含在长全文里', () => {
    const longer = 'dsh-ops 插件从 npm 华为云源重装 0.4.4，runtime 三件齐，受限沙箱可用，bash 执行器路径覆盖已配置，回退只需删除 bashPath'
    const shorter = 'dsh-ops 插件重装记录，详见全文'
    expect(isSameTopic(shorter, longer)).toBe(true)
  })

  it('兄弟记录不误合并：共享领域词但内容各自独立', () => {
    const a = 'dsh-our-free-model 免费模型插件，npm 作用域名与裸包名互斥，用 alias 装法修好，客户端重复注册会启动失败'
    const b = 'dsh-ops 的 bash 执行器换成 niu.exe，受限模式只认 pinned MSYS，自定义路径仅全访问可用'
    expect(isSameTopic(a, b)).toBe(false)
  })

  it('指路牌特例：交集仅 2 也判同主题', () => {
    const shorter = 'dsh-memory 整理会话。详细记忆与完整过程详见 memory/consolidation-worker-max-tokens.md。记录日期 2026-11-02。'
    const longer = 'dsh-memory 整理 worker 输出截断根因与修复，记忆整合的详细过程与验证记录都在这里'
    expect(isSignpostText(shorter)).toBe(true)
    expect(isSameTopic(shorter, longer)).toBe(true)
  })

  it('交集不足且非指路牌 → 不同主题', () => {
    const a = 'QNAP NAS 共享文件夹权限配置'
    const b = 'dsh-ops 的 bash 执行器换成 niu.exe'
    expect(isSameTopic(a, b)).toBe(false)
  })
})

describe('demoteHeadings', () => {
  it('丢首个 # 标题，其余标题各降一级', () => {
    expect(demoteHeadings('# 标题\n正文\n## 小节\n内容\n### 深层\n')).toBe(
      '正文\n### 小节\n内容\n#### 深层\n',
    )
  })

  it('六级标题封顶不再加深', () => {
    expect(demoteHeadings('## 顶\n###### 底\n')).toBe('### 顶\n###### 底\n')
  })

  it('无标题行时原样保留正文', () => {
    expect(demoteHeadings('只有正文\n')).toBe('只有正文\n')
  })
})

describe('stripSignpostSections', () => {
  const fuller = [
    '# GLOBAL',
    '',
    '## dsh-ops 重装记录',
    'dsh-ops 插件从 npm 华为云源重装 0.4.4，runtime 三件齐，受限沙箱可用。安装命令与验证步骤都在这里，还包括 bash 执行器路径覆盖与回退方法，以及卸载清理的注意事项。',
    '',
    '## dsh-ops 索引',
    'dsh-ops 插件重装记录，详见 memory/dsh-ops-removal.md。记录日期 2026-11-03。',
    '',
    '## 其他主题',
    '完全不同的内容，讲的是 QNAP NAS 的共享文件夹权限配置。',
    '',
  ].join('\n')

  it('删掉指路牌节（同内容存在更完整同主题节）', () => {
    const out = stripSignpostSections(fuller)
    expect(out).toContain('## dsh-ops 重装记录')
    expect(out).toContain('## 其他主题')
    expect(out).not.toContain('## dsh-ops 索引')
  })

  it('孤零零的短节不删（无更完整同主题节）', () => {
    const lone = ['# GLOBAL', '', '## 唯一小节', '详见 memory/something.md。记录日期 2026-11-03。', ''].join('\n')
    expect(stripSignpostSections(lone)).toBe(lone)
  })
})
