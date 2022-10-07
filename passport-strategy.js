const LocalStrategy = require('passport-local').Strategy;
// const bcrypt = require('bcrypt');

function initialize(passport, getUserByEmail, getUserById) {
  const authenticateUser = async (email, password, done) => {
    const user = await getUserByEmail(email);
    const userJson = JSON.parse(user);

    if (user == null) {
      return done(null, false, { message: 'No user with that email' });
    }

    try {
      if (password === userJson.password) {
        return done(null, userJson);
      } else {
        return done(null, false, { message: 'Password incorrect' });
      }
    } catch (e) {
      console.log(e);

      return done(e);
    }
  };

  passport.use(new LocalStrategy({ usernameField: 'email' }, authenticateUser));
  passport.serializeUser((userJson, done) => done(null, userJson.id));
  passport.deserializeUser((id, done) => {
    return done(null, getUserById(id));
  });
}

module.exports = initialize;
