(() => {
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('[data-report-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.getAttribute('data-report-action');
      if (action !== 'openHistory' && action !== 'stop' && action !== 'inspectCase') return;
      if (action === 'stop') { button.disabled = true; button.textContent = '正在停止…'; }
      vscode.postMessage({ action, ...(action === 'inspectCase' ? { caseId: button.getAttribute('data-case-id') } : {}) });
    });
  });
})();
