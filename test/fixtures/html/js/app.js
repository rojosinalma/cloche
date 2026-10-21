document.getElementById('status').textContent = 'script ran';
const out = [];
try { document.cookie; out.push('cookie readable'); } catch (e) { out.push('no cookie'); }
try { localStorage.length; out.push('storage readable'); } catch (e) { out.push('no storage'); }
try { window.parent.document.title; out.push('parent readable'); } catch (e) { out.push('no parent'); }
document.getElementById('isolation').textContent = out.join(', ');
