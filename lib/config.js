// dsh-soul · 配置面（= DSH 设置页里那张卡片）
//
// 机制（已核实，非推断）：
//   - 表单的 namespace = profile entry 的 id（也就是 patch 里 `id: dsh-soul`）
//   - **可编辑字段 = 标了 `.volatile()` 的那些**
//   - 编辑会合并进 profile 的插件行，并**直接提交进 apply 收到的实时引用**，
//     不重挂 fiber、不用改文件、不用重启
//   - 没标 volatile 的字段仍是普通配置（改它需要重载）
//
// 为什么 schemastery 是**内置副本**（`./vendor/schemastery.cjs`）：
//   宿主的模块解析沿**真实路径**走。插件的真实路径在 D:\1，
//   那条路找不到 profile 的 node_modules——实测 `@deepseek-ai/schemastery`
//   从 D:/1/ds-soul/package/lib/index.js 出发是 MODULE_NOT_FOUND。
//   所以内置一份（连同它唯一的依赖 cosmokit，零依赖，共 ~41KB 纯 JS）。
//   这份副本只改了一行 require，其余逐字节保持上游 3.18.4。
import Schema from './vendor/schemastery.cjs';

/**
 * 打开「实时引用」：宿主支持 `.volatile()` 时标上，不支持就原样返回。
 * `.volatile()` 是 schemastery 3.18.3 起的方法，旧版上直接调用会抛。
 * （这个写法和 dsh-memento 的 liveField 一致，不是我自己发明的。）
 */
function live(schema) {
  return typeof schema?.volatile === 'function' ? schema.volatile() : schema;
}

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  recordEnabled: live(Schema.boolean()).default(true).description('是否记录会话中形成的经历。关闭后不新增自动经历。'),
  personaEvolutionEnabled: live(Schema.boolean()).default(true).description('是否允许我自主修订现行人格。关闭后 soul_seed 的修改操作被拒绝。'),
  summaryEnabled: live(Schema.boolean()).default(true).description('是否生成仅供主人查看的人格发展摘要。摘要不参与我的上下文。'),
  summaryIntervalHours: live(Schema.number()).min(1).max(720).step(1).default(24).description('人格发展摘要的最短生成间隔（小时）。'),

  // ── 人设种子：你写的那段起点 ──────────────────────────────────────────
  //
  // 这是"我从什么原则开始形成自己"，不是"我是什么样的人"。
  // 仅作旧配置的首次迁移入口。现行人格独立存在共享身份库。
  // 常规保存不覆盖现行人格；重设必须由人格窗口明确执行。
  personaSeed: Schema.string()
    .role('textarea')
    .description(
      '你写下的初始人设。它不是束缚——我可以根据记忆库和自己的判断改它。\n' +
      '可以写三类：①我们之间发生过什么 ②我打算怎么处理事情（能被行为违反的那种）③我不许对自己做什么。\n' +
      '不建议写抽象断言（"我是一个温柔的人"）——那种话只能被我表演。',
    )
    .default(''),

  // ── 注入预算 ─────────────────────────────────────────────────────────
  injectEnabled: live(Schema.boolean()).default(true).description('是否每轮把想起来的经历带进上下文。关掉后只有 soul_recall 能唤起。'),
  injectCapChars: live(Schema.number()).min(120).max(4000).default(700).description('每轮注入的字符硬顶。注意力比磁盘稀缺。'),
  injectLimit: live(Schema.number()).min(1).max(12).default(5).description('每轮最多带进几条经历。'),

  // ── 衰减（遗忘曲线）───────────────────────────────────────────────────
  // 半衰期是**首记的稳定性**；实际衰减走 S/(S+1.2t) 的双曲线，
  // 而且每次被想起会把稳定性乘 1.8（间隔重复效应：想起来越频繁，忘得越慢）。
  halfLifeDays: live(Schema.number()).min(1).max(3650).default(30)
    .description('记忆的初始半衰期（天）。这是"刚记下、还没被想起过"的衰减速度；被想起一次会变慢 1.8 倍。'),
  minActivation: live(Schema.number()).min(0).max(1).default(0.06).description('低于这个"此刻强度"就不再自然到场上（它还在库里，只是我想不起来）。'),

  // ── 自我理解 ─────────────────────────────────────────────────────────
  selfNotesEnabled: live(Schema.boolean()).default(true).description('是否让我维护"我目前认为我可能是这样"的认识。它可以被怀疑、被撤回。'),
  selfNoteCap: live(Schema.number()).min(1).max(200).default(40).description('active 状态的认识上限。有上限才会发生合并、降级、拒绝晋升。'),

  // ── core ────────────────────────────────────────────────────────────
  coreCap: live(Schema.number()).min(1).max(200).default(40).description('core 的硬上限。core 的价值在于它少——满了要进来，得有别的先出去。'),
});
