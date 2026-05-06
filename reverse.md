# Claude Code 官方校验算法逆向报告（2.1.88）

本文档记录目前对 Claude Code 2.1.88 官方客户端中两个关键校验/归因相关算法的逆向结论：

- `fingerprint`（也就是 `cc_version=2.1.88.xxx` 里的 3 位后缀）
- `cch`（`x-anthropic-billing-header` 中的 5 位十六进制值）

本文以**公开 npm 包 / sourcemap / 本地已安装官方 ELF 二进制 / 动态调试**为证据来源，目标是给出可复现、可实现、可验证的结论。

---

## 1. 结论摘要

### 1.1 fingerprint 算法

官方 2.1.88 JS 层可恢复出的算法是：

1. 取**第一条 user 消息文本**
2. 取该文本的下标 `4`、`7`、`20` 三个字符
3. 缺失字符用 `'0'` 补
4. 拼接固定盐值 `59cf53e54c78`
5. 再拼接 `cliVersion`
6. 做 `SHA-256`
7. 取十六进制结果前 **3 位小写 hex**

即：

```text
fingerprint = sha256("59cf53e54c78" + ch[4] + ch[7] + ch[20] + cliVersion).hex()[:3]
```

### 1.2 cch 算法

官方 2.1.88 native 路径最终实现是：

1. 对**完整请求 body 字节序列**做哈希
2. 哈希时 `x-anthropic-billing-header` 中 `cch` 槽位仍然是 `cch=00000`
3. 使用 **seeded XXH64**，种子为：

```text
0x6e52736ac806831e
```

4. 计算结果取**低 20 位**
5. 渲染为 **5 位小写十六进制**
6. 原地覆盖回请求 body 中 `cch=` 后面的 5 个字符

即：

```text
cch = lower_20_bits( XXH64_seeded(full_request_body_with_cch_zeroed, 0x6e52736ac806831e) )
cch_hex = hex(cch)[2:].lower().rjust(5, '0')
```

---

## 2. 证据来源概览

本次逆向使用了四类证据：

### 2.1 官方 npm 包（2.1.88）

通过本地下载并解包：

```text
@anthropic-ai/claude-code@2.1.88
```

确认包内包含：

- `cli.js`
- `cli.js.map`

`cli.js.map` 中可恢复出官方 JS 层源码片段，包括：

- `../src/utils/fingerprint.ts`
- `../src/constants/system.ts`
- `../src/utils/workloadContext.ts`
- `../src/utils/envUtils.ts`

这些足以恢复：

- `fingerprint` 算法
- attribution header 的可见 JS 层形态
- `CLAUDE_CODE_ATTRIBUTION_HEADER` 开关语义
- `cc_workload` 逻辑

### 2.2 本地安装的官方 Claude Code ELF

本机已安装官方 Claude Code：

```text
/home/fadouse/.local/share/claude/versions/2.1.88
```

该文件是 ELF 64-bit 可执行文件，未完全 strip，可用于：

- 字符串定位
- 代码段反汇编
- gdb 动态调试

### 2.3 运行时动态调试

通过：

- `gdb`
- `LD_PRELOAD` tracer
- watchpoint / breakpoint

证明了：

- JS 可见层确实先产生 `cch=00000`
- native 路径会在发送前把同一块 body buffer 中的 `00000` 改成非零值
- 该值不是简单的 request-id / session-id 哈希
- 最终可以在同一次运行中闭环证明：
  - prewrite body
  - native hash 返回值 `rax`
  - postwrite `cch`

### 2.4 当前插件代码集成

当前仓库已把恢复出来的算法接入到发送前 body 变换路径中，代码主要位于：

- `src/transforms.ts`

插件实现策略为：

- helper 级 API 仍保留官方 JS 层的可见占位符：`cch=00000`
- 实际 send-path 对最终 serialized body 执行 `cch` 填充

这与官方“JS 层可见 placeholder，native 层最终填充”的分层一致。

---

## 3. fingerprint 逆向结论

### 3.1 官方 JS 源恢复结果

通过 `cli.js.map` 中 `../src/utils/fingerprint.ts` 可恢复出：

- 固定盐值：

```text
59cf53e54c78
```

- 取字符下标：

```text
[4, 7, 20]
```

- 缺字符时用 `'0'`

### 3.2 精确算法

设：

- `messageText` = 第一条 user message 的文本内容
- `version` = Claude Code 版本，例如 `2.1.88`

则：

```text
chars = (messageText[4] ?? '0') + (messageText[7] ?? '0') + (messageText[20] ?? '0')
seed = '59cf53e54c78' + chars + version
fingerprint = sha256(seed).hex().slice(0, 3)
```

### 3.3 在 attribution header 中的使用

最终会形成：

```text
cc_version=<version>.<fingerprint>
```

例如：

```text
cc_version=2.1.88.e09
```

这也是为什么同一 prompt / 同一版本下，`fingerprint` 可能稳定，而 `cch` 仍然变化。

---

## 4. attribution header 可见 JS 层结论

### 4.1 官方 JS 层只构造 placeholder

官方 2.1.88 可见 JS 层构造的是：

```text
x-anthropic-billing-header: cc_version=<version>.<fingerprint>; cc_entrypoint=<entrypoint>; cch=00000;[ cc_workload=<workload>;]
```

也就是说：

- JS 层**不会**生成最终非零 `cch`
- JS 层只把 `cch=00000` 放进 body

### 4.2 `CLAUDE_CODE_ATTRIBUTION_HEADER`

官方 JS 层还支持通过环境变量禁用 attribution header：

- `0`
- `false`
- `no`
- `off`

这些值都会使 attribution header 不注入。

### 4.3 `cc_workload`

官方 JS 层支持通过 workload context 在 attribution header 中追加：

```text
cc_workload=cron;
```

这部分已经在当前插件中对齐。

---

## 5. cch 逆向过程与关键结论

### 5.1 先证明 `cch` 不是固定值

对同一路径多次运行最小请求：

```text
claude -p hi --model claude-haiku-4-5-20251001 --output-format json --max-budget-usd 0.02
```

抓到的 `cch` 多次不同，例如：

- `9ae9b`
- `e955d`
- `56a8c`
- `93d28`
- `ec4ef`
- `e1eb2`
- `b3d07`
- `eea1f`

说明 `cch` 不是常量。

### 5.2 先排除“仅由可见 body 决定”

把多个抓到的 body 样本中 `cch` 槽位统一归一化回 `00000` 之后：

- 三个 zeroed body **字节级完全相同**
- 但原始运行得到的 `cch` 仍然不同

因此可得：

> `cch` 不是简单的“只根据最终可见 body 文本 deterministically 计算”的值。

这里的真正原因后来通过动态调试确认：

- 我们最初抓到的 body dump 不是总能保证和 native 真正输入哈希的那一瞬间完全一致
- 只有后续在精确断点上 dump 的 `exact-cch-input.bin` 才是权威输入

### 5.3 先排除 request-id / session-id 的简单哈希

我对这些候选都做过验证：

- `sha256(request_id)`
- `sha256(session_id)`
- `sha256(request_id|session_id)`
- `md5(...)`
- `crc32(...)`
- `adler32(...)`
- `blake2s(...)`

均不匹配真实运行时 `cch`。

因此：

> `cch` 不是 request-id / session-id 的简单哈希截断。

---

## 6. 动态调试关键突破：`00000 -> 非零` 的真实边界

### 6.1 先找到最终写回点

通过 gdb watchpoint，对 live request body 中的 `cch=00000` 槽位做硬件监视，得到：

- 写入发生在：

```text
0x374e2f2
0x374e2f9
```

其中：

- `0x374e2f2` 写入前 4 个十六进制字符
- `0x374e2f9` 写入第 5 个字符

### 6.2 再找到哈希输入范围

在调用 `0x32429e0` 前截获寄存器和内存：

- `rbx` 指向完整 request body buffer
- `r14` 是 body 长度
- `r12` 是 `cch` 槽位偏移

并确认：

- `rbx` 开头就是完整 JSON body
- buffer 中明确包含 `cch=00000`

因此：

> native 哈希输入是**完整请求 body 字节序列**，且当时槽位仍为 `00000`。

---

## 7. seeded XXH64 的静态证据

### 7.1 初始化常量

在 `0x374e180..0x374e240` 看到对栈上 state 的初始化：

- `0xcf3c9b5975c738f4`
- `0x310521a7efdb6e6d`
- `0x6e52736ac806831e`
- `0xd01af9b9421ab897`

这与 `XXH64_reset(state, seed)` 完全吻合。

若设：

```text
seed = 0x6e52736ac806831e
```

则：

- `v3 = seed`
- `v4 = seed - PRIME64_1 = 0xd01af9b9421ab897`
- `v2 = seed + PRIME64_2 = 0x310521a7efdb6e6d`
- `v1 = seed + PRIME64_1 + PRIME64_2 = 0xcf3c9b5975c738f4`

完全一致。

### 7.2 update / finalize 路径

调用关系已收敛为：

- `0x32429e0`：XXH64 update 风格逻辑
- `0x30c4040`：XXH64 finalize 风格逻辑

随后返回值进入 nibble 提取和 hex 渲染。

---

## 8. 最终 same-run 闭环证明

这是最关键的一次同运行证明。

### 8.1 gdb 在写入前抓到

在 `0x374e24a`：

```text
rax = 0x6838ae5c9118f5f1
eax = 0x9118f5f1
```

同一时刻 body 中仍然是：

```text
cch=00000
```

同时把这一刻的真实输入 body dump 到：

```text
.inspect-native-cch/final-proof-input.bin
```

### 8.2 写入后同一运行看到

在 `0x374e2fe` 之后，同一块 body buffer 中变成：

```text
cch=8f5f1
```

### 8.3 本地复算 seeded XXH64

对 **同一次运行 dump 出来的 prewrite body** 做复算：

```text
XXH64_seeded(body, 0x6e52736ac806831e) = 0x6838ae5c9118f5f1
```

与 gdb 当场抓到的 `rax`：

```text
0x6838ae5c9118f5f1
```

**完全一致**。

再取低 20 位：

```text
0x6838ae5c9118f5f1 & 0xfffff = 0x8f5f1
```

与最终写回的：

```text
cch=8f5f1
```

**完全一致**。

这就把整个链条闭合了。

---

## 9. cch 的精确定义

设：

- `body_bytes` = 最终发送前的完整 JSON request body 的 UTF-8 字节序列
- 其中 attribution 文本里 `cch` 槽位仍为 `cch=00000`

则：

```text
h = XXH64_seeded(body_bytes, 0x6e52736ac806831e)
cch = hex(h & 0xfffff).lower().padStart(5, '0')
```

### 9.1 更接近实现的伪代码

```python
SEED = 0x6e52736ac806831e

def compute_cch(body_with_zeroed_slot: bytes) -> str:
    h = xxh64_seeded(body_with_zeroed_slot, SEED)
    return f"{h & 0xfffff:05x}"
```

### 9.2 为什么必须“先是 00000”

因为 native 路径的顺序是：

1. JS 层先把 `cch=00000` 放进 body
2. native 对该 body 做 seeded XXH64
3. 再把结果写回这 5 个字符

所以如果你在插件里直接拿“已填好 cch 的 body”再去算，会得到错误结果。

---

## 10. 当前插件中的落地方式

当前仓库已经把逆出的 `cch` 算法集成进发送前 body 变换路径。

主要代码位置：

- `src/transforms.ts`

### 10.1 分层策略

为了保持与官方可见 JS 层 / native 层的分工一致，当前实现分两层：

#### helper 层

这些 helper 仍然保留官方 JS 层可见行为：

- `getAttributionHeader(...)`
- `buildBillingHeaderValue(...)`
- `buildBillingSystemText(...)`

它们仍然产出：

```text
cch=00000
```

#### 实际发送层

在 `transformBody(...)` 的最终返回前：

1. 先 `JSON.stringify(...)`
2. 得到最终 serialized body
3. 对其中第一个 `cch=00000` 槽位执行 seeded XXH64 计算
4. 原地替换 5 位十六进制字符

这样最终 outgoing body 就与官方 native 行为一致。

### 10.2 关键 caveat

即便算法已经完全对齐，**最终数值是否和官方一模一样**仍取决于：

> 你的最终 serialized body 字节序列，是否与官方客户端发送前的 body 字节完全一致。

任何差异都会改变 `cch`：

- key 顺序
- JSON 转义方式
- system 文本内容
- metadata 字段顺序
- whitespace（如果有）
- 任何消息内容差异

所以：

- **算法层面**：现在已经对齐
- **值层面**：只有在 body bytes 完全一致时才会完全相同

---

## 11. fingerprint 与 cch 的关系

这两个值都出现在 attribution 文本里，但职责不同：

### 11.1 fingerprint

- 来源：第一条 user message 的少量字符 + 固定盐 + version
- 长度：3 位 hex
- 位置：`cc_version=2.1.88.<fingerprint>`
- 特点：同 prompt / 同 version 时往往稳定

### 11.2 cch

- 来源：完整 request body 的 seeded XXH64 低 20 位
- 长度：5 位 hex
- 位置：`cch=<5 hex>`
- 特点：对最终 body bytes 极度敏感

因此：

- `fingerprint` 更像 prompt/version 派生的轻量标记
- `cch` 更像发送前 body 的完整性校验值 / attestation 相关值

---

## 12. 逆向过程中排除过的错误理论

以下理论都已被明确否定：

### 12.1 `cch = SHA256(body)[:5]`

否。

### 12.2 `cch = SHA256(zeroed_body)[:5]`

否。

### 12.3 `cch = MD5/CRC32/Adler32/BLAKE2s(body or ids)[:5]`

否。

### 12.4 `cch = request-id 的简单哈希`

否。

### 12.5 `cch = session-id 的简单哈希`

否。

### 12.6 `cch = 无 seed 的 XXH64(body)`

否。

只有以下说法被 runtime + static 双重证据支持：

> `cch = seeded XXH64(full_body_with_zeroed_slot) & 0xfffff`

---

## 13. 复现实装建议

如果要在其他语言/项目里复现，建议遵循：

1. 先完全确定最终 JSON body 的字节序列
2. 确保其中是：

```text
cch=00000
```

3. 用标准 XXH64 算法，但必须带 seed：

```text
0x6e52736ac806831e
```

4. 取低 20 位
5. 输出 5 位小写 hex
6. 原地覆盖，不改变 body 长度

---

## 14. 风险与安全说明

在本次动态调试过程中，我抓到过明文 HTTP request buffer，其中包含：

- `Authorization: Bearer ...`

因此本地 Claude 登录 token 已可视为对调试输出暴露过。若在真实环境继续做类似调试，建议：

- 立刻轮换 / 撤销相关 token
- 不要把原始 request dump 提交到仓库
- 不要把含 token 的调试产物外发

---

## 15. 最终结论

### fingerprint

```text
fingerprint = sha256("59cf53e54c78" + msg[4] + msg[7] + msg[20] + version).hex()[:3]
```

### cch

```text
cch = hex( XXH64_seeded(full_request_body_with_cch_zeroed, 0x6e52736ac806831e) & 0xfffff )[2:].lower().rjust(5, '0')
```

并且这个 `cch` 结论已经通过**同一次运行**的以下四点完成闭环证明：

1. prewrite body 里确实是 `cch=00000`
2. native 在该 body 上运行 seeded XXH64
3. gdb 抓到的 `rax` 与本地复算结果完全一致
4. postwrite body 中的 `cch` 等于该 `rax` 的低 20 位转成的 5 位小写 hex

这意味着：

> 目前对 Claude Code 2.1.88 中 `fingerprint` 与 `cch` 的恢复，已经达到可复现、可实装、可验证的程度。
