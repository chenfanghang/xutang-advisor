import type { GenerationInput, ScenarioId } from "./api";

const common = {
  client_information:
    "林女士（虚构），偏好轻便、简洁的日常用品，预算一万元以内。",
  contact_status: "active" as const,
};
export const examples: Record<ScenarioId, GenerationInput> = {
  greeting: {
    ...common,
    scenario: "greeting",
    product_ids: [],
    conversation_history: "客户：谢谢，上次看过的款式我再考虑一下。",
    scenario_information: "今天是客户生日，顾问想送上简短祝福。",
  },
  recommendation: {
    ...common,
    scenario: "recommendation",
    product_ids: ["light-crossbody"],
    conversation_history: "客户：周末出门想轻松一些，手机和卡包能装下就好。",
    scenario_information: "推荐满足轻便需求的随身包，不额外承诺库存。",
  },
  post_purchase: {
    ...common,
    scenario: "post_purchase",
    product_ids: ["arc-shoulder"],
    conversation_history: "客户：上周买的肩包今天第一次带去上班。",
    scenario_information: "关心使用体验，必要时提示基础保养。",
  },
  reactivation: {
    ...common,
    scenario: "reactivation",
    product_ids: [],
    conversation_history: "六个月前，客户：最近比较忙，有需要再找您。",
    scenario_information: "此前未表示拒绝联系，希望轻量问候，不强推购买。",
  },
  event_invitation: {
    ...common,
    scenario: "event_invitation",
    product_ids: [],
    conversation_history: "客户：对皮具制作过程比较感兴趣，周末有时有空。",
    scenario_information:
      "虚构活动：2026年11月14日14:00至16:00，序棠示例精品店，皮具工艺小型预览。客户可先表达意向，未确认名额。",
  },
  price_objection: {
    ...common,
    scenario: "price_objection",
    product_ids: ["arc-shoulder", "light-crossbody"],
    conversation_history:
      "客户：这只肩包有些贵，能打折吗？我想控制在七千左右。",
    scenario_information:
      "统一定价，不承诺折扣；可提供预算内的轻舟斜挎包作为备选。",
  },
};
