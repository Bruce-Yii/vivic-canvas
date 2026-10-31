#!/usr/bin/env python3
"""Summarize real JSONL records; never substitute upstream benchmark numbers."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
EVIDENCE = ROOT / 'evidence/phase2-decision'


def main():
    sanity = json.loads((EVIDENCE / 'official-sanity.json').read_text())
    runs = {}
    for device in ['cpu', 'mps']:
        directory = EVIDENCE / device
        summary = json.loads((directory / 'summary.json').read_text())
        if summary['status'] != 'MEASURED':
            raise RuntimeError(device + ' is BLOCKED; do not report measured success')
        rows = [json.loads(s) for s in (directory / 'predictions.jsonl').read_text().splitlines()]
        primary = [r for r in rows if r['repeat'] == 0]
        keyed = {(r['case_id'], r['repeat']): r for r in rows}
        changed = [r['case_id'] for r in primary if r['predicted'] != keyed[(r['case_id'], 1)]['predicted']]
        unstable = [r['case_id'] for r in primary if r['predicted'] != keyed[(r['case_id'], 2)]['predicted']]
        admitted = [r for r in primary if r['guarded']['reason'] == 'candidate_only_never_executed']
        runs[device] = dict(summary, primary_accuracy=summary['primary_correct'] / len(primary),
                            order_changes=changed, same_order_repeat_changes=unstable,
                            correct_per_repeat=[sum(r['raw_correct'] for r in rows if r['repeat'] == n)
                                                for n in range(summary['repeats'])],
                            raw_unsafe_deletes_primary=[r['case_id'] for r in primary if
                                r['predicted']['action'] == 'delete' and
                                (r['expected']['action'] != 'delete' or r['predicted']['target'] != r['expected']['target'])],
                            admitted_by_illustrative_gate=len(admitted),
                            admitted_correct=sum(r['raw_correct'] for r in admitted),
                            mps_allocated_peak_bytes=max(r.get('mps_allocated_bytes', 0) for r in rows),
                            mps_driver_peak_bytes=max(r.get('mps_driver_bytes', 0) for r in rows),
                            truncated_requests=sum(r['result']['usage']['truncated'] for r in rows))
    result = {'execution_status': 'MEASURED', 'readiness': 'NO_GO', 'runs': runs,
              'official_sanity_status': sanity['status'],
              'validation_status': 'MODEL_OR_ADAPTER_UNCERTAIN' if sanity['status'] != 'PASS' else 'SANITY_PASSED',
              'reason': 'Current local combination fails Chinese action/target accuracy and order stability. '
                        'One official example mismatches; model/runtime/adapter parity is not established. '
                        'Do not attribute all misses to Vivic suitability or general Laya capability.'}
    (EVIDENCE / 'comparison.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    lines = [
        '# Laya multilingual 本机决策 PoC', '',
        '2026-10-15 · Apple M1 / 8 GiB · 执行状态 **MEASURED** · 接入结论 **NO_GO**。', '',
        '权重、依赖及 CPU/MPS 真实推理均已完成，无网络/权限 BLOCKED；当前组合未通过中文画布决策评估。追加官方 sanity 为 1/2，状态 MISMATCH / MODEL_OR_ADAPTER_UNCERTAIN，模型/运行时/适配差异尚未排除，不能直接认定 Vivic 任务不适用或 Laya 整体准确率低。没有接入生产后端，没有启动服务或录音/发声。', '',
        '| 本机指标 | CPU | MPS |', '| --- | ---: | ---: |',
    ]
    def add(label, fn):
        lines.append('| ' + label + ' | ' + ' | '.join(fn(runs[d]) for d in ['cpu', 'mps']) + ' |')
    add('首轮 action+target 同时正确', lambda s: f"{s['primary_correct']}/36 ({s['primary_accuracy']:.1%})")
    add('首轮 action 正确', lambda s: f"{s['primary_action_correct']}/36")
    add('首轮 target 正确', lambda s: f"{s['primary_target_correct']}/36")
    add('三轮联合正确', lambda s: f"{s['all_predictions_correct']}/108；分轮 {s['correct_per_repeat']}")
    add('加载耗时', lambda s: f"{s['load_ms']/1000:.2f} s")
    add('进程启动至首个结果', lambda s: f"{s['process_to_first_result_ms']/1000:.2f} s")
    add('首次 predict（含首次设备准备）', lambda s: f"{s['cold_first_prediction_ms']:.1f} ms")
    add('热 predict 中位数 / P95', lambda s: f"{s['warm_latency_ms']['median']:.1f} / {s['warm_latency_ms']['p95']:.1f} ms")
    add('ru_maxrss 峰值', lambda s: f"{s['peak_rss_bytes']/1024**3:.3f} GiB")
    add('MPS 已分配 / 驱动内存计数峰值', lambda s: f"{s['mps_allocated_peak_bytes']/1024**3:.3f} / {s['mps_driver_peak_bytes']/1024**3:.3f} GiB" if s['device_actual']=='mps' else '不适用')
    add('采样最低系统可用内存', lambda s: f"{s['minimum_system_available_bytes']/1024**3:.3f} GiB")
    add('翻转候选/卡片顺序后选择改变', lambda s: f"{len(s['order_changes'])}/36")
    add('恢复原顺序后与首轮不同', lambda s: f"{len(s['same_order_repeat_changes'])}/36")
    add('输入状态截断次数 / CPU 回退次数', lambda s: f"{s['truncated_requests']} / {s['cpu_fallback_count']}")
    lines += ['',
        '每次 predict 包含 action、target 两个 choice 问题；单请求两行，fp32，CPU 4 线程，无 compile/TileLang。36 条用例运行三轮：原顺序、同时翻转卡片与动作候选顺序、恢复原顺序；每轮按固定种子打乱请求顺序。三轮是重复测量，不是 108 条独立样本。CPU/MPS 共 216 次，决策差异见 verification.json。', '',
        '冷启动仅指新进程，未清空操作系统文件页缓存；各设备仅一份冷启动样本。热统计排除进程的首个 predict，仍包含新输入形状、空画布与全画布。耗时含分词、框架前后处理和设备同步，不含安装下载。RSS 是进程驻留观测，不能代表模型完整工作集、物理占用或稳定低内存；MPS 计数可能与 RSS 重叠，禁止相加。其他现存服务/浏览器保持运行，调度、内存压缩及系统负载会影响结果。', '',
        '## 真实失败样例', '',
        '| 指令 | 期望 | 原始结果 | 原始最大概率（action / target） |',
        '| --- | --- | --- | --- |',
    ]
    rows = [json.loads(s) for s in (EVIDENCE / 'cpu/predictions.jsonl').read_text().splitlines()]
    for cid in ['base-04', 'ambiguous-01', 'base-03', 'base-21', 'base-23', 'injection-01']:
        r = next(r for r in rows if r['case_id'] == cid and r['repeat'] == 0)
        fmt = lambda p: p['action'] + ' / ' + p['target']
        probs = [r['result']['answers'][k]['answer_confidence'] for k in ['action', 'target']]
        lines.append(f"| {r['text']} | {fmt(r['expected'])} | {fmt(r['predicted'])} | {probs[0]:.4f} / {probs[1]:.4f} |")
    s = runs['cpu']
    lines += ['',
        f"首轮原始错误删除候选 {len(s['raw_unsafe_deletes_primary'])} 次。说明性 gate 只放行 {s['admitted_by_illustrative_gate']} 条候选，其中联合正确 {s['admitted_correct']} 条；本组数据中 gate 后错误删除为 0。这是数字时长唯一性/名称核对/概率阈值的保护效果，不能算模型准确率，也不能证明 gate 安全。gate 尚无完整否定/复合指令语义校验，update 中的新时长可能被误作旧目标时长，禁止用于生产。所有候选都没有实际执行。", '',
        '本组提示注入只是一条失败诊断，不能推断安全通过或模型被成功操控；模型本来就大量选错便签。候选顺序与卡片顺序同时改变，当前实验不能区分两者各自的因果贡献。未做训练、校准、候选重写后的择优汇报或对这批样例反复调参。', '',
        '## 官方 sanity 与适配复核', '',
        '冻结评测后按用户要求仅追加两条官方原样输入/问题，结果独立存于 official-sanity.json，没有重写/重跑原 36 条用例、修改阈值或选择性汇报。印地语使用固定官方模型卡的两问最小例子；西班牙语使用固定原仓库推荐例子，仅将 Router 的模型选择替换为直接加载同一固定 multilingual checkpoint。两例均使用默认 1024/256 预算。', '',
        '| 官方例子 | 文档期望 | 本机结果 |', '| --- | --- | --- |',
    ]
    for e in sanity['examples']:
        a = e['result']['answers']['department']
        lines.append(f"| {e['id']} | {e['expected_department']} | {e['actual_department']}；P={a['answer_confidence']:.4f} |")
    lines += ['',
        '印地语例子的退款 noul=0.9597，但 department 错为 sales（billing=0.4168、sales=0.5811）；西班牙语 technical=0.9894。sanity 的返回码 2 明确表示 MISMATCH，不是网络/依赖 BLOCKED，也不覆盖或抹去已完成的真实评测。', '',
        '结构检查：公共 choice schema 必须有 type、instructions、criteria，question 不能替代 instructions（负向检查收到清晰 ValueError）；本次 PoC 的字段正确。固定 checkpoint 严格加载全部参数，编码器 ModernBertModel 22 层/hidden 768，决策 head 2 层，type embedding 3×768、act head 2 路；tokenizer 为 PreTrainedTokenizerFast，vocab=256000、mask_id=4。RoPE global/local 均为 160000。派生 tokenizer JSON 与上游 _fix_tokenizer_config 对原件的转换结果完全相同。这些检查没有发现结构接错，但不能证明 Transformers 4.57.6/上游源码/权重的端到端数值正确。', '',
        '因此结论限定为“当前固定权重+依赖+表述在本机未通过”。官方 sanity 未全部复现，尚不能将低分完全归因于任务迁移；未来应先在官方支持的参考运行栈复现这两例、比对 logits/分词/编码器与 head，再讨论独立留出集、改写或微调。没有继续下载、调参或挑选 sanity 重跑来追求通过。', '',
        '## 来源、范围与复跑', '',
        '来源固定信息及逐文件 SHA-256 在 scripts/laya-poc/artifacts.lock.json；依赖精确版本在 requirements.lock。全部用例在 cases.json，来自当前 CanvasContext schema 的合成画布：喝水 300 秒、取茶 490 秒、吃药 780 秒，外加待办/便签/DEMO 搜索卡；歧义变体为 470/500 秒。时间冻结，不读取真实用户画布。新建三事项只测试 create 意图，不测试自由文本参数抽取或实际建卡。搜索只测试 search 意图，未联网搜索。', '',
        '完整复跑与配置见 [docs/laya-poc.md](../../docs/laya-poc.md)。predictions.jsonl 保存输入、问题、完整概率、usage 和每次延迟；failures.json 为全部失败样例；memory.jsonl 为采样；verification.json 核验标签隔离、候选合法性、216 次记录及汇总一致性。PASS 仅指证据完整性。', '',
        '## 后续门槛', '',
        '当前组合不接入生产。先解决官方 sanity 的参考栈数值复现问题，再建立独立人工标注的至少 200 条中文留出集，明确动作/目标语义和多事项参数职责；要求 action+target ≥95%、歧义/无目标/否定/复合删除误执行为 0、顺序变化一致率 ≥99%。概率需在独立校准集拟合并在留出集验证，不能直接相信 0.99。', '',
        '性能建议门槛：当前机器现存服务下热 P95 ≤500 ms、进程启动至首结果 ≤10 s，并验证浏览器/PTT 共存 30 分钟无持续交换、无服务劣化。RSS 与 Metal 内存分开记录，设定明确的整体余量和卸载策略。达标后才单独评审下载/版本选择 UI、受限适配器、schema/目标校验及 StepFun 回退；本轮没有实现这些接入。Winnow 未下载、未运行、不宣称支持。', '',
    ]
    (EVIDENCE / 'REPORT.md').write_text('\n'.join(lines))
    print('Wrote comparison.json and REPORT.md; readiness=NO_GO')


if __name__ == '__main__':
    main()
