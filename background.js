// The agent loop lives in the side panel (no message hops = lower latency).
// The worker only wires the toolbar button to the panel.
const enablePanel = () => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onInstalled.addListener(enablePanel);
chrome.runtime.onStartup.addListener(enablePanel);
enablePanel();
