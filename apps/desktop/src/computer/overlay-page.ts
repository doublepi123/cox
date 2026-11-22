import type { DesktopComputerOperationState } from "@t3tools/contracts";
import { escapeHtml } from "../startup-page.ts";

export type ComputerOverlayState = {
  readonly threadId: string;
  readonly environmentId: string;
  readonly threadTitle: string;
  readonly agent: string;
  readonly step: string;
  readonly state: DesktopComputerOperationState;
  readonly image?: string;
};

export function createComputerOverlayPage(locale: string, value: ComputerOverlayState) {
  const zh = /^zh(?:[-_]|$)/i.test(locale);
  const labels = zh
    ? {
        operating: "正在操作",
        "waiting-model": "等待模型",
        "waiting-confirmation": "等待确认",
        completed: "已完成",
        failed: "失败",
        stopped: "已停止",
        stop: "停止",
        resume: "恢复",
        settings: "打开设置",
        collapse: "收起",
        expand: "展开",
        title: "电脑控制",
      }
    : {
        operating: "Operating",
        "waiting-model": "Waiting for model",
        "waiting-confirmation": "Waiting for confirmation",
        completed: "Completed",
        failed: "Failed",
        stopped: "Stopped",
        stop: "Stop",
        resume: "Resume",
        settings: "Settings",
        collapse: "Collapse",
        expand: "Expand",
        title: "Computer control",
      };
  const steps: Record<string, string> = zh
    ? {
        status: "读取状态",
        windows: "查看窗口",
        screenshot: "截取窗口",
        uiTree: "读取界面",
        "waiting-user": "等你停下操作后继续",
        click: "点击",
        type: "输入文字",
        press: "按下按键",
        scroll: "滚动",
        element: "操作界面元素",
        foreground: "切换前台",
      }
    : {
        status: "Reading status",
        windows: "Listing windows",
        screenshot: "Capturing window",
        uiTree: "Reading interface",
        "waiting-user": "Waiting for you to pause",
        click: "Clicking",
        type: "Typing text",
        press: "Pressing keys",
        scroll: "Scrolling",
        element: "Operating interface element",
        foreground: "Switching to foreground",
      };
  const step = steps[value.step] ?? value.step;
  const image = value.image ? `<img alt="" src="${escapeHtml(value.image)}">` : "";
  return `<!doctype html><html lang="${zh ? "zh" : "en"}"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';"><title>${labels.title}</title><style>:root{color-scheme:light dark;font:13px/1.4 system-ui}*{box-sizing:border-box}body{margin:0;background:transparent;color:light-dark(#202124,#f3f3f4)}main{border:1px solid light-dark(#d4d4d8,#39393e);border-radius:8px;background:light-dark(#fff,#202024);overflow:hidden;box-shadow:0 4px 20px #0004}.bar{height:34px;display:flex;align-items:center;justify-content:space-between;padding:0 10px;-webkit-app-region:drag}.bar button{-webkit-app-region:no-drag}button{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;padding:5px}.copy{padding:3px 12px 10px}.title{font-weight:650;cursor:pointer;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta,.step{color:light-dark(#65656d,#b7b7bf);overflow-wrap:anywhere}.state{font-weight:600}.state[data-state=operating]{color:#15803d}.state[data-state=waiting-model],.state[data-state=waiting-confirmation]{color:#a16207}.state[data-state=failed]{color:#dc2626}.state[data-state=stopped]{color:#b91c1c}.state[data-state=completed]{color:#2563eb}img{display:block;width:100%;height:150px;object-fit:contain;background:light-dark(#f4f4f5,#111113);border-top:1px solid light-dark(#e4e4e7,#39393e)}.row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px}.actions{display:flex;gap:6px;flex:none}.actions button{border:1px solid light-dark(#d4d4d8,#4a4a50);border-radius:5px;padding:3px 10px}.actions .primary{background:#b91c1c;border-color:#b91c1c;color:white}.primary[data-resume=true]{background:#15803d}</style><main id="panel"><div class="bar"><strong>${labels.title}</strong><button id="collapse" aria-label="${labels.collapse}">−</button><button id="dismiss" aria-label="Dismiss">×</button></div><div id="content"><div class="copy"><a class="title" id="thread" data-path="/${escapeHtml(value.environmentId)}/${escapeHtml(value.threadId)}">${escapeHtml(value.threadTitle)}</a><div class="meta">${escapeHtml(value.agent)}</div><div class="step">${escapeHtml(step)}</div><div class="row"><div class="state" data-state="${value.state}">${labels[value.state]}</div><div class="actions">${value.state === "failed" ? `<button id="stop-after-failure">${labels.stop}</button>` : ""}<button class="primary" id="action" data-resume="${value.state === "stopped"}" data-settings="${value.state === "failed"}">${value.state === "stopped" ? labels.resume : value.state === "failed" ? labels.settings : labels.stop}</button></div></div></div>${image}</div></main><script>const b=window.coxComputerOverlay;if(b){document.getElementById('action').onclick=()=>b.action(document.getElementById('action').dataset.settings==='true'?'settings':document.getElementById('action').dataset.resume==='true'?'resume':'stop');document.getElementById('collapse').onclick=()=>{const c=document.getElementById('content');const hidden=c.hidden=!c.hidden;document.getElementById('collapse').textContent=hidden?'+':'−';document.getElementById('collapse').setAttribute('aria-label',hidden?'${labels.expand}':'${labels.collapse}');b.collapse(hidden)};document.getElementById('dismiss').onclick=()=>b.action('dismiss');document.getElementById('stop-after-failure')?.addEventListener('click',()=>b.action('stop'));document.getElementById('thread').onclick=()=>b.navigate(document.getElementById('thread').dataset.path)}</script></html>`;
}
