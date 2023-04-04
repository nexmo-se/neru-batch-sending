const LocalStrategy = require("passport-local").Strategy;
const OIDCStrategy = require("passport-azure-ad").OIDCStrategy;
// const bcrypt = require('bcrypt');

function initialize(passport, getUserByEmail, fn2, fn3) {
  const authenticateUser = async (email, password, done) => {
    const userJson = await getUserByEmail(email);
    // const userJson = JSON.parse(user);

    if (userJson == null) {
      return done(null, false, { message: "No user with that email" });
    }

    try {
      if (password === userJson.password) {
        return done(null, userJson);
      } else {
        return done(null, false, { message: "Password incorrect" });
      }
    } catch (e) {
      console.log(e);

      return done(e);
    }
  };

  passport.use(new LocalStrategy({ usernameField: "email" }, authenticateUser));
  passport.serializeUser((userJson, done) => {
    console.log("serialize" + userJson.email);
    return done(null, userJson.email);
  });
  passport.deserializeUser((email, done) => {
    console.log(email);
    return done(null, fn2(email));
  });

  // Microsoft Azure Strategy
  const { passport } = JSON.parse(process.env.NERU_CONFIGURATIONS);
  const {
    identityMetadata,
    clientID,
    responseType,
    responseMode,
    redirectUrl,
    allowHttpForRedirectUrl,
    clientSecret,
    validateIssuer,
    isB2C,
    issuer,
    passReqToCallback,
    scope,
    loggingLevel,
    useCookieInsteadOfSession,
    cookieSameSite,
    cookieEncryptionKeys,
    clockSkew,
  } = passport.microsoftAd;

  const findByOid = async (profile, callback) => {
    const userJson = await getUserByEmail(profile.email);

    if (userJson == null) {
      return done("No user with that email", null);
    }

    try {
      if (profile.oid === userJson.oid) {
        return done(null, userJson);
      } else {
        return done("Password incorrect", null);
      }
    } catch (e) {
      console.error(e);
      return done(`Error: ${e}`, null);
    }
  };

  passport.use(
    new OIDCStrategy(
      {
        identityMetadata: identityMetadata,
        clientID: clientID,
        responseType: responseType,
        responseMode: responseMode,
        redirectUrl: redirectUrl,
        allowHttpForRedirectUrl: allowHttpForRedirectUrl,
        clientSecret: clientSecret,
        validateIssuer: validateIssuer,
        isB2C: isB2C,
        issuer: issuer,
        passReqToCallback: passReqToCallback,
        scope: scope,
        loggingLevel: loggingLevel,
        useCookieInsteadOfSession: useCookieInsteadOfSession,
        cookieSameSite: cookieSameSite, // boolean
        cookieEncryptionKeys: cookieEncryptionKeys,
        clockSkew: clockSkew,
      },
      function (iss, sub, profile, accessToken, refreshToken, done) {
        if (!profile.oid) {
          return done(new Error("No oid found"), null);
        }
        if (!profile.email) {
          return done(new Error("No email found"), null);
        }
        // asynchronous verification, for effect...
        process.nextTick(function () {
          try {
            findByOid(profile, function (err, user) {
              if (err) {
                return done(err);
              }
              if (!user) {
                // "Auto-registration"
                fn3(profile);
                return done(null, profile);
              }
              return done(null, user);
            });
          } catch (e) {
            console.error(e);
            return done("Error: " + e, null);
          }
        });
      }
    )
  );
}

module.exports = initialize;
