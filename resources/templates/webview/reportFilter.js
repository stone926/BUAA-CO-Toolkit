(() => {
  const filters = document.querySelector('[data-report-filters]');
  if (!filters) return;
  const search = filters.querySelector('input[type="search"]');
  const status = filters.querySelector('select');
  const reset = filters.querySelector('button');
  const count = document.getElementById('filter-count');
  const empty = document.getElementById('filter-empty');
  const region = document.querySelector('.table-scroll');
  const rows = Array.from(document.querySelectorAll('tbody tr'), (element) => ({
    element,
    text: element.textContent.toLocaleLowerCase(),
    status: element.className
  }));
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
  const saved = vscode?.getState();
  if (saved && typeof saved.query === 'string') search.value = saved.query;
  if (saved && Array.from(status.options).some((option) => option.value === saved.status)) status.value = saved.status;
  function apply() {
    const query = search.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const row of rows) {
      const matchesStatus = !status.value || (status.value === 'problem'
        ? row.status === 'failed' || row.status === 'error'
        : row.status === status.value);
      row.element.hidden = !matchesStatus || !row.text.includes(query);
      if (!row.element.hidden) visible++;
    }
    count.textContent = '显示 ' + visible + ' / ' + rows.length + ' 个测试点';
    empty.hidden = visible > 0;
    if (region) region.hidden = visible === 0;
    reset.disabled = !search.value && !status.value;
    vscode?.setState({ query: search.value, status: status.value });
  }
  search.addEventListener('input', apply);
  status.addEventListener('change', apply);
  reset.addEventListener('click', () => {
    search.value = '';
    status.value = '';
    apply();
    search.focus();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { search.value = ''; apply(); }
  });
  apply();
})();
