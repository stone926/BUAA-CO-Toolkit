(() => {
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('[data-failure-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.getAttribute('data-failure-action');
      const index = button.getAttribute('data-index');
      vscode.postMessage({ action, ...(index === null ? {} : { index: Number(index) }) });
    });
  });
})();
