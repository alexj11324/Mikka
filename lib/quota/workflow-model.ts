import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from '@workflow/serde'
import type { gateway } from 'ai'
import type { ModelSource } from '../resources/runtime'
type GatewayModel=ReturnType<typeof gateway.languageModel>

/** #265's actual model-step adapter with trusted durable source scope. */
export class QuotaWorkflowModel {
  readonly specificationVersion='v4' as const
  readonly provider='gateway'
  readonly supportedUrls={}
  constructor(readonly source:ModelSource,readonly modelId:string,readonly resource:'coordinator.model'|'coordinator.compact'='coordinator.model'){}
  static [WORKFLOW_SERIALIZE](model:QuotaWorkflowModel){return{source:model.source,modelId:model.modelId,resource:model.resource}}
  static [WORKFLOW_DESERIALIZE](data:{source:ModelSource;modelId:string;resource:'coordinator.model'|'coordinator.compact'}){return new QuotaWorkflowModel(data.source,data.modelId,data.resource)}
  async doGenerate(options:Parameters<GatewayModel['doGenerate']>[0]){
    'use step'
    const {getStepMetadata}=await import('workflow')
    const {generateResourceModel}=await import('../resources/runtime')
    return generateResourceModel(this.source,this.modelId,this.resource,getStepMetadata().stepId,options)
  }
  async doStream(_options:Parameters<GatewayModel['doStream']>[0]):Promise<Awaited<ReturnType<GatewayModel['doStream']>>>{throw new Error('quotaStreamingUnsupported')}
}
