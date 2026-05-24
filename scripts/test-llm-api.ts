/**
 * 测试 Vision LLM API 调用
 */

async function testVisionLLMAPI() {
  const apiUrl = "https://ergouzi.life/chat/completions";
  const token = "sk-7T9ohVgZYSOFbBSgPfyHeOBKAAk58vhq8CC1QvrGBjvLcbeR";
  const model = "gpt-4o-mini";

  console.log("🧪 测试 Vision LLM API 调用...");
  console.log("URL:", apiUrl);
  console.log("Model:", model);
  console.log("");

  try {
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "user", content: "用两句话介绍 Ergouzi API。" }
        ]
      })
    });

    console.log("Status:", resp.status);
    console.log("Content-Type:", resp.headers.get("content-type"));

    if (resp.ok) {
      const data = await resp.json();
      console.log("\n✅ API 调用成功！");
      console.log("Response:", JSON.stringify(data, null, 2));
    } else {
      const text = await resp.text();
      console.log("\n❌ API 调用失败");
      console.log("Response body (first 500 chars):", text.slice(0, 500));
    }
  } catch (error) {
    console.error("\n❌ 发生错误:", error);
  }
}

testVisionLLMAPI();
