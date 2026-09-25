/**
 * 轻量弹层：确认框 / 表单输入
 *
 * 为什么不用 window.confirm / window.prompt：
 *   1. 被 iframe sandbox 拦 —— 未给 allow-modals 时浏览器直接忽略调用，
 *      confirm 一律返回 false、prompt 返回 null，调用方看到的是「点了没反应」；
 *   2. 被 Chrome「阻止此页面创建更多对话框」拦 —— 同样静默返回 false；
 *   3. 样式无法跟随主题，在嵌入场景里格格不入。
 * 任一情况都会让「删除对话」这类破坏性操作静默失效，所以这里自研一套。
 *
 * 用法：
 *   const ok = await confirm({ title: '删除对话', message: '...', danger: true });
 *   const v  = await form({ title: '添加附件', fields: [{ key: 'url', label: '地址' }] });
 */

let activeMask = null;

/**
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.message]
 * @param {Array<{key:string,label:string,value?:string,placeholder?:string,multiline?:boolean}>} [o.fields]
 * @param {string} [o.okText]
 * @param {string} [o.cancelText]
 * @param {boolean} [o.danger]
 * @returns {Promise<true|false|Record<string,string>|null>}
 */
function openModal(o) {
  return new Promise((resolve) => {
    // 同一时刻只允许一个弹层，旧的直接按取消收尾，避免 Promise 永久悬挂
    if (activeMask) activeMask.__settle(null);

    const fields = o.fields || [];
    const returnFocus = o.__returnFocus || document.activeElement;
    const mask = document.createElement('div');
    mask.className = 'modal-mask';

    const box = document.createElement('div');
    box.className = 'modal';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.tabIndex = -1;

    const h = document.createElement('h3');
    h.textContent = o.title || '提示';
    box.appendChild(h);

    if (o.message) {
      const p = document.createElement('p');
      p.className = 'modal-desc';
      p.textContent = o.message;
      box.appendChild(p);
    }

    const inputs = [];
    for (const f of fields) {
      const wrap = document.createElement('label');
      wrap.className = 'modal-field';
      const span = document.createElement('span');
      span.textContent = f.label || f.key;
      wrap.appendChild(span);
      const inp = document.createElement(f.multiline ? 'textarea' : 'input');
      if (!f.multiline) inp.type = 'text';
      inp.value = f.value || '';
      inp.placeholder = f.placeholder || '';
      if (f.multiline) inp.rows = 3;
      wrap.appendChild(inp);
      box.appendChild(wrap);
      inputs.push({ key: f.key, el: inp });
    }

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const btnCancel = document.createElement('button');
    btnCancel.type = 'button';
    btnCancel.className = 'm-btn';
    btnCancel.textContent = o.cancelText || '取消';
    const btnOk = document.createElement('button');
    btnOk.type = 'button';
    btnOk.className = `m-btn ${o.danger ? 'danger' : 'primary'}`;
    btnOk.textContent = o.okText || '确定';
    actions.appendChild(btnCancel);
    actions.appendChild(btnOk);
    box.appendChild(actions);

    mask.appendChild(box);
    document.body.appendChild(mask);
    activeMask = mask;

    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      if (activeMask === mask) activeMask = null;
      document.removeEventListener('keydown', onKey, true);
      mask.remove();
      // 把焦点还给触发弹层的元素，键盘用户不会「迷路」
      if (returnFocus && document.contains(returnFocus)) {
        try {
          returnFocus.focus({ preventScroll: true });
        } catch {
          /* ignore */
        }
      }
      resolve(value);
    };
    mask.__settle = settle;

    const readValues = () => {
      const out = {};
      for (const { key, el: inp } of inputs) out[key] = inp.value.trim();
      return out;
    };
    const isEmpty = () => !fields.length || inputs.every((i) => i.el.value.trim());

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        settle(fields.length ? null : false);
        return;
      }
      if (e.key === 'Enter') {
        const multiline = e.target && e.target.tagName === 'TEXTAREA';
        if (multiline && !e.ctrlKey && !e.metaKey) return; // 多行输入里 Enter 换行
        e.preventDefault();
        e.stopPropagation();
        if (!isEmpty()) return; // 必填未填，抖动提示
        settle(fields.length ? readValues() : true);
      }
    };

    btnCancel.addEventListener('click', () => settle(fields.length ? null : false));
    btnOk.addEventListener('click', () => {
      if (!isEmpty()) {
        box.classList.add('shake');
        setTimeout(() => box.classList.remove('shake'), 320);
        return;
      }
      settle(fields.length ? readValues() : true);
    });
    mask.addEventListener('mousedown', (e) => {
      if (e.target === mask) settle(fields.length ? null : false);
    });
    document.addEventListener('keydown', onKey, true);

    // 自动聚焦：有输入框聚焦输入框，否则聚焦主按钮，方便直接回车
    const first = inputs.length ? inputs[0].el : btnOk;
    try {
      first.focus({ preventScroll: true });
      if (inputs.length) first.select();
    } catch {
      /* ignore */
    }
  });
}

/** 确认框，返回 boolean */
export const confirm = (o) => openModal({ ...o, fields: [] }).then((v) => v === true);

/** 表单框，返回 { key: value } 或 null */
export function form(o) {
  return openModal(o).then((v) => (v && typeof v === 'object' ? v : null));
}
