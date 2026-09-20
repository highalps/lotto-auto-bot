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
      window.autoCallCount = 0;
      window.selectedNumbers = [];
      window.doAuto = () => {
        window.autoCallCount += 1;
        window.data = { resultCode: "100", resultMsg: "", selLotNo: "123456" };
      };
      window.addBuyDataOne = (lotNo) => {
        window.selectedNumbers.push(lotNo);
        const input = document.querySelector("input[name='BUY_CNT']");
        input.value = String(Number(input.value) + 1);
      };
      window.doOrderRequest = () => {
        document.querySelector(".orderNo").textContent =
          window.autoCallCount + ":" + window.selectedNumbers.join(",");
      };
    </script>
  </body>
</html>`;

test("uses one random Pension720 number across different groups in the delayed game iframe", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  await context.route("**/game/TotalGame.jsp?LottoId=LP72", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: outerPage });
  });
  await context.route("**/game/pension720/mock", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: gameFrame });
  });

  try {
    let submissions = 0;
    const result = await buyPension720Auto(context, { gameCount: 3, onSubmit: () => { submissions++; } });
    assert.equal(submissions, 1);
    assert.deepEqual(result, {
      requestedGameCount: 3,
      selectedGameCount: 3,
      orderNo: "1:1123456,2123456,3123456"
    });
  } finally {
    await context.close();
    await browser.close();
  }
});
