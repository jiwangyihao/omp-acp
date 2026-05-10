export default function disableAskInAcp(pi) {
  pi.on("before_agent_start", async () => {
    const activeTools = pi.getActiveTools();
    if (!activeTools.includes("ask")) return;
    await pi.setActiveTools(activeTools.filter((name) => name !== "ask"));
  });
}
