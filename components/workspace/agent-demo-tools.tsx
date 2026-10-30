'use client'

import { FileDiff } from '@/components/agents/file-diff'
import { ToolResult, ToolResultOutput } from '@/components/agents/tool-result'
import { Citations } from '@/components/agents/citations'
import { ImageGeneration } from '@/components/agents/image-generation'
import { withBasePath } from '@/lib/base-path'

export function AgentDemoTools() {
  return <div className="flex min-w-0 flex-col gap-4">
    <p className="text-sm text-muted-foreground">以下全部为虚构工具记录，只展示组件效果；不会运行命令、修改文件或生成图片。</p>
    <FileDiff file="demo.ts（演示差异）" defaultOpen collapseOnComplete={false} lines={[
      { id: 'old', type: 'removed', oldLine: 1, content: 'const title = "旧标题"' },
      { id: 'new', type: 'added', newLine: 1, content: 'const title = "演示标题"' },
    ]} />
    <ToolResult tool="本地演示" title="示例工具输出（未执行）" status="success" defaultOpen collapseOnComplete={false}>
      <ToolResultOutput language="json">{'{"demo": true, "executed": false}'}</ToolResultOutput>
    </ToolResult>
    <Citations title="来源展示（演示）" defaultOpen citations={[{ id: 'demo', title: '示例引用，不对应真实检索结果', domain: '本地演示' }]} />
    <ImageGeneration status="complete" label="图片展示（演示占位图）" statusText="本地占位图，未生成图片" interactive={false} size="compact">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={withBasePath('/placeholder.svg?height=360&width=640')} alt="本地演示占位图，非模型生成" width={640} height={360} />
    </ImageGeneration>
  </div>
}
