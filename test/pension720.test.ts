import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { buyPension720Auto } from "../src/lotto/pension720.js";

const outerPage = `<!doctype html>
<html>
  <body>
    <p>LP72 wrapper without game controls</p>
    <script>
      setTimeout(() => {
        const iframe = document.createElement("iframe");
        iframe.src = "/game/pension720/mock";
        document.body.appendChild(iframe);
      }, 300);
    </script>
  </body>
</html>`;

const gameFrame = `<!doctype html>
<html>
  <body>
    <form id="frm"><input name="BUY_CNT" value="0"></form>
    <a onclick="doAuto()">자동선택</a>
    <div id="lotto720_popup_pay"><span class="orderNo"></span></div>
    <script>
      window.doAuto = () => {
        window.data = { resultCode: "100", resultMsg: "", selLotNo: "123456" };
      };
      window.addBuyDataOne = () => {
        const input = document.querySelector("input[name='BUY_CNT']");
        input.value = String(Number(input.value) + 1);
      };
      window.doOrderRequest = () => {
        document.querySelector(".orderNo").textContent = "TEST-ORDER";
      };
    </script>
  </body>
</html>`;

test("waits for the delayed LP72 game iframe instead of selecting the wrapper", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  await context.route("**/game/TotalGame.jsp?LottoId=LP72", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: outerPage });
  });
  await context.route("**/game/pension720/mock", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: gameFrame });
  });

  try {
    const result = await buyPension720Auto(context, { gameCount: 1 });
    assert.deepEqual(result, {
      requestedGameCount: 1,
      selectedGameCount: 1,
      orderNo: "TEST-ORDER"
    });
  } finally {
    await context.close();
    await browser.close();
  }
});
