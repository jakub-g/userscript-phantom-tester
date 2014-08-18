// this file is executed in the scope of PhantomJS

// PhantomJS requires
var webpage = require('webpage');
var system = require('system');

// this is an npm require
var colors = require('colors');

// local requires
var client = require('./client');

// ============================================================================

var CFG = parseCommandLineCfg();

function parseCommandLineCfg () {
    var aCmdArgs = system.args;
    var bGlobalColor = aCmdArgs.indexOf('--color') > -1;
    var bGlobalDebug = aCmdArgs.indexOf('--debug') > -1;
    var bGlobalVerbose = aCmdArgs.indexOf('--verbose') > -1;

    var sxunitVarName;
    aCmdArgs.forEach(function (arg) {
        var match = arg.match(/\-\-xunitName=(.+)/);
        if (match) {
            sxunitVarName = match[1];
        }
    });

    if (!bGlobalColor) {
        colors.mode = "none";
    }

    if (bGlobalDebug) {
        console.log("PhantomJS command line args : " + aCmdArgs.join(" "));
    }
    return {
        color : bGlobalColor,
        debug : bGlobalDebug,
        verbose : bGlobalVerbose,
        xunitName : sxunitVarName || "assert"
    };
}

/**
 * Returns a new function `test` that is test gatherer and runner in one.
 * The returned function can be called like this: `test("My test name", function (args) { }`
 * and this will add a new test to the queue.
 *
 * To start the execution of all tests in queue, one should call `test.start()`.
 * @return {Function}
 */
function getTestRunner (page, testArgs) {
    var pendingTests = [];
    var testRunner = function (testName, testFn) {
        pendingTests.push({
            testName : testName,
            testFn : testFn
        });
    };

    testRunner.start = function () {
        while (pendingTests.length > 0) {
            var test = pendingTests.shift();
            var testFn = client.wrapWithTryCatch();
            var ok = page.evaluate(testFn, test.testFn, testArgs);

            console.log( (ok ? (" [ OK ] ".green.bold) : (" [FAIL] ".red.bold)) + test.testName);
        }
    };
    return testRunner;
}

/**
 * Opens `url` in Phantom, injects `this._userScriptPaths` userscripts, calls test function `gatherTest`
 * with one argument `test` to gather the tests, then feeds those tests to the test runner,
 * and starts the test runner.
 *
 * Usage:
 * <pre>
 *   phantomTester._openAndTest("http://example.com/", function (test) {
 *      test('should do something', function () {
 *          assert.eq(1, 1);
 *      });
 *
 *      test('should do something else', function () {
 *          assert.eq(1, 2);
 *      });
 *   });
 * </pre>
 * @param {String} url
 * @param {Function} feedRunnerWithTests The function that will gather tests to execute once run
 * @param {Integer} suiteId Sequential number of the current suite (for printing)
 * @param {Function} done Callback to be called on suite finish (it should start
 * the next suite or exit Phantom once all suites are done)
 */
function openAndTest(url, feedRunnerWithTests, suiteId, done) {

    var userConf = this._config;
    userConf.phantom = userConf.phantom || {};
    var bDebug = (userConf.phantom.debug !== undefined) ? userConf.phantom.debug : CFG.debug;
    var bVerbose = (userConf.phantom.verbose !== undefined) ? userConf.phantom.verbose : CFG.verbose;

    var testArgs = this._testArgs || {};

    var verbose = {
        log : bVerbose ? function (msg) {
            console.log(msg);
        } : function () {}
    };
    var ignoredErrors = userConf.phantom.ignoredErrors || null;

    var page = webpage.create();
    page.onConsoleMessage = function (msg) {
        var padding = '  >>> ' ;
        console.log(padding + (""+msg).replace(/\n/g, "\n" + padding));
    };

    page.onError = function(msg, trace) {
        var magicString = "ASSERT_FAIL";
        var isAssertFail = msg.indexOf(magicString) >= 0;

        if (bDebug && !isAssertFail) {
            var ignore = false;
            if (ignoredErrors) {
                ignore = ignoredErrors.some(function (ignoredMsg) {
                    return msg.indexOf(ignoredMsg) > -1;
                });
            }
            if (!ignore) {
                var msgStack = ['PHANTOM ERROR: ' + msg];
                if (trace && trace.length) {
                    trace.forEach(function(t) {
                      msgStack.push(' -> ' + (t.file || t.sourceURL) + ': ' + t.line + (t.function ? ' (in function ' + t.function +')' : ''));
                    });
                    msgStack.push("");
                }
                console.error(msgStack.join('\n'));
            }
        }

        if (isAssertFail) {
            var strip = 7; // leading "Error: ";
            console.error(msg.slice(strip));
            //console.log("Test suite failed, exiting with error code 1");
            //phantom.exit(1);
        }
    };

    var _this = this;

    // Inject polyfills into the environment before the page is loaded
    page.onInitialized = function() {
        var pfPaths = _this._polyfillPaths;
        if (!pfPaths) {
            throw new Error("phantom-tester: _polyfillPaths is not defined");
        }
        for (var i = 0; i < pfPaths.length; i++) {
            verbose.log(" * Injecting the polyfill... (" + pfPaths[i] + ")");
            var injected = page.injectJs(pfPaths[i]);
            // verbose.log("  " + (injected ? "OK" : "FAILED"));
            if (!injected) {
                throw new Error("Can't inject polyfill into the page...");
            }
        }
    };

    page.open(url, function (status) {
        verbose.log(" Initializing the test:");
        verbose.log(" * Page loaded with status " + status);
        //verbose.log(" * URL: " + url.yellow + " loaded with status " + status);

        var usPaths = _this._userScriptPaths;
        if (!usPaths) {
            throw new Error("phantom-tester: _userScriptPaths is not defined");
        }
        for (var i = 0; i < usPaths.length; i++) {
            verbose.log(" * Injecting the userscript... (" + usPaths[i] + ")");
            var injected = page.injectJs(usPaths[i]);
            // verbose.log("  " + (injected ? "OK" : "FAILED"));
            if (!injected) {
                throw new Error("Can't inject userscript into the page...");
            }
        }

        verbose.log(" * Injecting the unit test utils... ");
        var xunit = _this._xunit;
        if (xunit) {
            verbose.log(" * Using user-supplied xunit... ");
        }
        xunit = xunit || client.xunit;
        page.evaluate(xunit, CFG.xunitName);

        verbose.log(" * Starting the tests... \n");
        var testRunner = getTestRunner(page, testArgs);
        feedRunnerWithTests(testRunner);
        testRunner.start();
        // verbose.log("\n* Tests finished.");

        onTestSuiteFinished(page, {
            id : suiteId,
            count : _this._registeredSuites.length
        }, done);
    });
}

function onTestSuiteFinished (page, suite, done) {
    var asserts = page.evaluate(function (xunitVarName) {
        return window[xunitVarName];
    }, CFG.xunitName);
    var hasFailures = asserts._badAsserts > 0;

    var msg = "\n  Test suite " + (suite.id + 1) + "/" + suite.count + " finished: ";
    msg += (asserts._goodAsserts + " asserts OK").green.bold;
    if (hasFailures) {
        msg += "; " + (asserts._badAsserts + " asserts KO").red.bold;
    }
    console.log(msg + "\n");

    done(hasFailures ? 99 : 0);
}

var br = Array(11).join("-");
module.exports = {

    /**
     * Sets internal cfg variable `this.userScriptPath` as provided, and returns `this` for chaining.
     * @param {String} userScriptPath
     */
    userScript : function (userScriptPath) {
        this._userScriptPaths.push(userScriptPath);
        return this;
    },

    polyfill : function (polyfillPath) {
        this._polyfillPaths.push(polyfillPath);
        return this;
    },

    setConfig : function (cfgObj) {
        this._config = cfgObj;
    },

    setTestArgs : function (args) {
        this._testArgs = args;
    },

    setXUnit : function (xunit) {
        this._xunit = xunit;
    },

    /**
     * Registers a suite to be executed via `openAndTest`. Params expected are same
     * as for `openAndTest`.
     * @see openAndTest
     */
    registerSuite : function (/*args*/) {
        this._registeredSuites.push([].slice.call(arguments, 0));
    },

    /**
     * Main entry point - starts the first suite to be executed.
     */
    start : function () {
        if (this._registeredSuites.length > 0) {
            //console.log(br);
            this._startSuite(0);
        } else {
            console.error("No suites registered!");
            phantom.exit(98);
        }
    },

    _xunit : null,
    _config : {},
    _testArgs : {},
    _polyfillPaths : [],
    _userScriptPaths : [],
    _registeredSuites : [],
    _exitCodes : [],

    _openAndTest : openAndTest,

    _startSuite : function (n) {
        var nSuites = this._registeredSuites.length;
        var args = this._registeredSuites[n];
        var url = args[0];
        if (n > 0) {
            console.log(br + "\n");
        }
        console.log("Starting test suite " + (n+1) + "/" + nSuites + ": " + url.yellow + "\n");
        args.push(n, this._getSuiteDoneCb(n));
        this._openAndTest.apply(this, args);
    },

    /**
     * Returns a callback function that will be called upon finishing of suite n.
     * The callback runs n+1-st suite, or in case of last suite, exits PhantomJS,
     * with proper exit code (failure code if any of suites failed, 0 otherwise).
     * @param {Integer} n
     * @return {Function}
     */
    _getSuiteDoneCb : function (n) {
        var that = this;
        var nSuites = this._registeredSuites.length;
        return function (exitCode) {
            // printing in 1-based values for user-friendliness
            // console.log("Test suite " + (n+1) + " finished with code " + exitCode);
            that._exitCodes.push(exitCode);
            var nextSuiteId = n+1;
            if (nextSuiteId < nSuites) {
                that._startSuite(nextSuiteId);
            } else {
                var hasError = that._exitCodes.indexOf(99) > -1;
                var msg = "All suites finished; ";
                if (hasError) {
                    msg = (msg + "there were some failures.").red;
                } else {
                    msg = (msg + "OK").green;
                }
                console.log(msg);
                phantom.exit(hasError ? 99 : 0);
            }
        };
    },

};
