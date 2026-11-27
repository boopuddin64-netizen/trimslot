/* Turns any thrown error into text that is safe and useful to show a person.
   - Errors we wrote on purpose (userError), and messages the API sent with an HTTP status, are shown as written.
   - Anything else (JavaScript runtime errors such as "Cannot read properties of undefined") is replaced by a plain fallback,
     so internal details never reach the screen. */
(function () {
  var GENERIC = 'Something went wrong. Please try again.';
  window.userError = function (msg) { var e = new Error(String(msg)); e.userFacing = true; return e; };
  window.userMessage = function (e, fallback) {
    var text = e && typeof e.message === 'string' ? e.message.trim() : '';
    var ok = !!text && (e.userFacing === true || e.code === 'NETWORK' || typeof e.status === 'number');
    return ok ? text.slice(0, 300) : (fallback || GENERIC);
  };
})();
