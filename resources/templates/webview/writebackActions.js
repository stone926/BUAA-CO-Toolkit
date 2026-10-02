(() => {
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('[data-writeback-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const row = button.getAttribute('data-row');
      const side = button.getAttribute('data-side');
      vscode.postMessage({ action: button.getAttribute('data-writeback-action'),
        ...(row === null ? {} : { row: Number(row) }), ...(side === null ? {} : { side }) });
    });
  });
  document.querySelector('[data-selected]')?.scrollIntoView({ block: 'center' });
})();
