module.exports = {
    env: {
        es2021: true,
        node: true,
        mocha: true,
    },
    extends: [
        "eslint:recommended",
        "plugin:@typescript-eslint/recommended",
        "prettier",
        "prettier/@typescript-eslint",
    ],
    parser: "@typescript-eslint/parser",
    parserOptions: {
        ecmaVersion: 12,
        sourceType: "module",
    },
    plugins: ["@typescript-eslint"],
    rules: {},
};
