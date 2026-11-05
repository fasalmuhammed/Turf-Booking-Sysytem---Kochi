// Confirmation prompts for destructive buttons + keep chat scrolled to the latest message.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-confirm]');
  if (el && !window.confirm(el.getAttribute('data-confirm'))) e.preventDefault();
});
const chat = document.getElementById('chat');
if (chat) chat.scrollTop = chat.scrollHeight;
