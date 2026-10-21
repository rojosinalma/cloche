// Info tab rows for viewers that show what a file says about itself (G-code
// header, STEP header, conversion state): fields [{ label, value }] become
// <tr><th>label</th><td>value</td></tr>, as text, never HTML.
export function fill(tbody, fields) {
  tbody.replaceChildren(...fields.map(({ label, value }) => {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = label;
    const td = document.createElement('td');
    td.textContent = value;
    tr.append(th, td);
    return tr;
  }));
}
