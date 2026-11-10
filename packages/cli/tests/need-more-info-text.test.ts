import { describe, expect, it } from "vitest";
import { needMoreInfoText } from "../src/main.js";

/**
 * 门禁追问（verdict 5 / NEED_MORE_INFO）的展示口径。
 *
 * 用户实测反馈：之前这条追问被夹在
 *   `failed policy_denied NEED_MORE_INFO`
 *   `✗ NEED_MORE_INFO`
 * 两行失败标记之间，读起来像「服务坏了」。真正要看的只有门禁写的那句
 * 「为完成 PoL 治理审核，需要你补充以下信息：…」。
 *
 * 这些用例锁的是「正文提取」这一层：前缀必须被削掉，正文必须一字不改。
 */
describe("needMoreInfoText", () => {
  const body =
    "为完成 PoL 治理审核，需要你补充以下信息：你指的是哪一块硬盘？；具体想做什么操作？";

  it("削掉当前 provider 的 `gate needs more info:` 前缀", () => {
    expect(needMoreInfoText(`gate needs more info: ${body}`)).toBe(body);
  });

  it("削掉带 provider id 的早期前缀 `gate \"gate\" needs more info:`", () => {
    expect(needMoreInfoText(`gate "gate" needs more info: ${body}`)).toBe(body);
  });

  it("也吃得下日志里出现过的 `error POL_NEED_MORE_INFO` 形态", () => {
    expect(needMoreInfoText(`gate "gate" error POL_NEED_MORE_INFO: ${body}`)).toBe(body);
  });

  it("正文里的半角冒号与引号必须原样保留", () => {
    const tricky = '为完成 PoL 治理审核，需要你补充以下信息：你说的 "其它硬盘" 是指 /dev/sdb1: 吗？';
    expect(needMoreInfoText(`gate needs more info: ${tricky}`)).toBe(tricky);
  });

  it("没有前缀时原样返回（不误删正文）", () => {
    expect(needMoreInfoText(body)).toBe(body);
  });

  it("空/缺失时给固定提示，绝不返回空串", () => {
    for (const input of [undefined, "", "   ", "gate needs more info:"]) {
      const text = needMoreInfoText(input);
      expect(text.length).toBeGreaterThan(0);
      expect(text).toBe("为完成 PoL 治理审核，需要你补充更多信息。");
    }
  });
});
