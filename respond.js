const ok = (res, data, status = 200, extra = {}) => res.status(status).json({ success: true, data, ...extra });
const fail = (res, status, message, errors) =>
  res.status(status).json({ success: false, message, ...(errors ? { errors } : {}) });
const serverError = (res, e) => {
  console.error(e);
  return fail(res, 500, 'Something went wrong. Please try again.');
};
module.exports = { ok, fail, serverError };
