(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var actions = { reanalyze: true, openInput: true, openJson: true };
  document.querySelectorAll('[data-action]').forEach(function (button) {
    button.addEventListener('click', function () {
      var action = button.getAttribute('data-action');
      if (Object.prototype.hasOwnProperty.call(actions, action)) {
        vscode.postMessage({ action: action });
      }
    });
  });

  var matrixFilter = document.getElementById('matrix-filter');
  var matrixCount = document.getElementById('matrix-count');
  var matrixEmpty = document.getElementById('matrix-empty');
  var matrixRows = Array.prototype.slice.call(document.querySelectorAll('.coverage-table tbody tr'));
  if (matrixFilter && matrixCount && matrixEmpty) {
    function filterMatrix() {
      var visible = 0;
      matrixRows.forEach(function (row) {
        var show = matrixFilter.value === 'all'
          || (matrixFilter.value === 'observed' && row.getAttribute('data-observed') === 'true')
          || (matrixFilter.value === 'gap' && row.getAttribute('data-gap') === 'true');
        row.hidden = !show;
        if (show) visible++;
      });
      matrixCount.textContent = '显示 ' + visible + ' / ' + matrixRows.length + ' 类';
      matrixEmpty.hidden = visible !== 0;
    }
    matrixFilter.addEventListener('change', filterMatrix);
    filterMatrix();
  }

  var kind = document.getElementById('event-kind');
  var validity = document.getElementById('event-valid');
  var search = document.getElementById('event-search');
  var count = document.getElementById('event-count');
  var empty = document.getElementById('event-empty');
  var items = Array.prototype.slice.call(document.querySelectorAll('#event-list .event-card'));
  if (!kind || !validity || !search || !count || !empty) return;

  function filterEvents() {
    var query = search.value.trim().toLocaleLowerCase();
    var visible = 0;
    items.forEach(function (item) {
      var show = (kind.value === 'all' || item.getAttribute('data-kind') === kind.value)
        && (validity.value === 'all' || item.getAttribute('data-valid') === validity.value)
        && (!query || (item.getAttribute('data-search') || '').indexOf(query) !== -1);
      item.hidden = !show;
      if (show) visible++;
    });
    count.textContent = '显示 ' + visible + ' / ' + items.length + ' 条';
    empty.hidden = visible !== 0;
  }

  kind.addEventListener('change', filterEvents);
  validity.addEventListener('change', filterEvents);
  search.addEventListener('input', filterEvents);
  filterEvents();
}());
