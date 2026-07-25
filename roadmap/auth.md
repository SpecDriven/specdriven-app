Done — GitHub App device flow (specs/git-operations.spec.md): the user
signs in from Settings via github.com/login/device; the token is the
HTTPS credential for both git engines and supplies the commit identity.
Cloning the data repo still doubles as the access check.

Remaining idea: verify *write* access explicitly at setup time (today a
missing write permission only surfaces on the first push).
