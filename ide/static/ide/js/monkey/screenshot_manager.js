CloudPebble.MonkeyScreenshots = (function() {

    /** A simple class with default values for Screenshot files */
    function ScreenshotFile(options) {
        var final = _.defaults(options || {}, {
            is_new: false,
            id: null,
            file: null,
            src: "",
            _changed: false
        });
        this.is_new = final.is_new;
        this.id = final.id;
        this.file = final.file;
        this.src = final.src;
        if (this.src.startsWith('/')) {
            this.src = interpolate("%s?%s", [this.src, (new Date().getTime())]);
        }
        this._changed = final._changed;
    }

    /** A simple class with default values for screenshot sets,
     * which makes ScreenshotFile instances of its children if it needs to.*/
    function ScreenshotSet(options) {
        var final = _.defaults(options || {}, {
            name: "",
            id: null,
            files: []
        });
        this.name = final.name;
        this.id = final.id;
        this.files = _.mapObject(final.files, function (file) {
            return ((file instanceof ScreenshotFile) ? file : new ScreenshotFile(file));
        });
    }

    /**
     * Put screenshot data in a format ready to be sent.
     * @param screenshots
     * @returns {{screenshots: Array, files: Array}}
     */
    var process_screenshots = function(screenshots) {
        var screenshots_data = [];
        var files = [];
        _.each(screenshots, function(screenshot) {
            var shot_data = {name: screenshot.name, files: {}};
            if (screenshot.id) {shot_data.id = screenshot.id;}
            _.each(screenshot.files, function(image, platform) {
                if (image.id || image.file) {
                    shot_data.files[platform] = {};
                    if (image.id) {shot_data.files[platform].id = image.id;}
                    if (image.file !== null) {
                        shot_data.files[platform].uploadId = files.length;
                        files.push(image.file);
                    }
                }
            }, this);
            if (_.keys(shot_data.files).length > 0)
                screenshots_data.push(shot_data);
        }, this);

        var form_data = new FormData();
        form_data.append('screenshots', JSON.stringify(screenshots_data));
        _.each(files, function(file) {
            form_data.append('files[]', file);
        });

        return form_data;
    };

    /** The screenshots API, gets from and saves to the Django backend */
    var AjaxAPI = function() {
        this.getScreenshots = function(test_id) {
            var url = "/ide/project/" + PROJECT_ID + "/test/" + test_id + "/screenshots/load";
            return Ajax.Ajax({
                url: url,
                dataType: 'json'
            }).then(function(result) {
                return _.map(result['screenshots'], function(screenshot_set) {
                    return new ScreenshotSet(screenshot_set);
                })
            });
        };

        this.saveScreenshots = function(test_id, new_screenshots) {
            var form_data = process_screenshots(new_screenshots);
            var url = "/ide/project/" + PROJECT_ID + "/test/" + test_id + "/screenshots/save";
            return Ajax.Ajax({
                url: url,
                type: "POST",
                data: form_data,
                processData: false,
                contentType: false,
                dataType: 'json'
            });

        }
    };

    /** Given a pebble object, request a screenshot from it
     * @param pebble{Pebble} Pebble to request a screenshot from
     * @param on_progress{Function} A callback to send progress to
     * @returns {Promise.<ScreenshotFile>} A promise which resolves with the new screenshot
     */
    function request_screenshot(pebble, on_progress) {
        var listener = _.extend({}, Backbone.Events);
        return (new Promise(function (resolve, reject) {
            var disconnect_if_not_virtual = function () {
                if (!SharedPebble.isVirtual()) {
                    SharedPebble.disconnect()
                }
            };
            listener.listenTo(pebble, 'close', function () {
                defer.reject(gettext("Disconnected from phone."));
            });

            listener.listenTo(pebble, 'screenshot:failed', function (error) {
                CloudPebble.Analytics.addEvent('monkey_app_screenshot_failed', {virtual: SharedPebble.isVirtual()});
                reject(new Error("Screenshot failed: " + error.message));
                disconnect_if_not_virtual();
            });

            listener.listenTo(pebble, 'screenshot:progress', function (received, expected) {
                if (_.isFunction(on_progress)) {
                    on_progress((received / expected) * 100);
                }
            });

            listener.listenTo(pebble, 'screenshot:complete', function (screenshot) {
                var src = screenshot.src;
                var blob = CloudPebble.Utils.ConvertDataURItoBlob(screenshot.src);
                resolve(new ScreenshotFile({src: src, blob: blob, is_new: true}));
                disconnect_if_not_virtual();
                CloudPebble.Analytics.addEvent('monkey_app_screenshot_succeeded', {virtual: SharedPebble.isVirtual()});
            });
            pebble.request_screenshot();
        })).finally(function () {
            listener.stopListening();
        });
    }

    /**
     * Get a pebble instance and take a screenshot from it
     * @param on_progress{Function} A callback to send progress to
     * @returns {Promise.<ScreenshotFile>} A promise which resolves with the new screenshot
     */
    var take_screenshot = function(on_progress) {
        return SharedPebble.getPebble().then(function(pebble) {
            return request_screenshot(pebble, on_progress);
        });
    };

    var API = new AjaxAPI();

    /**
     * ScreenshotsModel manages a list of new screenshot files to be uploaded
     * @fires 'changed' when files are added or modified
     * @fires 'progress' to indicate screenshot progress
     * @fires 'disabled' when beginning a save/screenshot process
     * @fires 'enabled' when a saves/screenshot process is complete
     * @fires 'error' when there are errors
     * @fires 'saved' when the screenshot form is successfully submitted
     * @constructor
     */
    function ScreenshotsModel(test_id) {
        var self = this;
        var screenshots = [];
        var original_screenshots = [];
        var disabled = false;
        var progress = {};
        _.extend(this, Backbone.Events);

        this.getScreenshots = function() {
            return _.clone(screenshots);
        };

        /**
         * Update the list of screenshots to be uploaded with some new files. If multiple files are added at one index,
         * each file[i] is added to the screenshot[index+i]
         * @param files an Array of File objects
         * @param index the screenshot index to update, or null for new screenshots
         * @param platform a string naming the platform for all of the new screenshots
         */
        this.addUploadedFiles = function(files, index, platform) {
            if (disabled) return;
            var onloads = [];
            if (!_.every(files, function(file) {
                    return (file.type == 'image/png');
                })) {
                this.trigger('error', {errorFor: gettext('add files'), message: 'screenshots must be PNG files.'})
                return;
            }
            var loadFile = function(screenshotfile) {
                var reader = new FileReader();
                var promise = new Promise(function(resolve) {
                    reader.onload = function() {
                        screenshotfile.src = reader.result;
                        resolve();
                    };
                });
                onloads.push(promise);
                reader.readAsDataURL(screenshotfile.file);
            };

            if (index === null) {
                // Append all new screenshots, given them no name
                _.each(files, function(file) {
                    var upload = new ScreenshotSet({_changed: true});
                    upload.files[platform] = new ScreenshotFile({file: file, is_new: true});
                    screenshots.push(upload);
                    loadFile(upload.files[platform]);
                });
            }
            else {
                _.each(files, function(file, i) {
                    var upload = screenshots[index + i];
                    if (upload) {
                        // Update existing screenshots at the current index
                        var id = (upload.files[platform] ? upload.files[platform].id : null);
                        upload.files[platform] = new ScreenshotFile({file:file, id: id, is_new: true});
                        loadFile(upload.files[platform]);
                    }
                    else {
                        // If there was no screenshot to update, add the remaining files as new screenshots.
                        this.addUploadedFiles(files.slice(i), null, platform);
                    }
                }, this);
            }
            Promise.all(onloads).then(function() {
                self.trigger('changed', screenshots);
            });
        };

        var set_progress = function(index, platform, percent) {
            var prog_obj = {};
            prog_obj[index] = {};
            prog_obj[index][platform] = percent;
            _.defaults(progress, prog_obj);
            _.extend(progress[index], prog_obj[index]);
            self.trigger('progress', progress);
        };

        var clear_progress = function(index, platform) {
            if (_.isObject(progress[index])) {
                progress[index] = _.omit(progress[index], platform);
                if (_.keys(progress[index]).length == 0) {
                    delete progress[index];
                }
            }
            self.trigger('progress', progress);
        };

        var set_disabled = function(new_disabled) {
            disabled = new_disabled;
            self.trigger(disabled ? 'disable' : 'enable');
        };

        this.takeScreenshot = function(index, platform) {
            if (disabled) return;
            set_disabled(true);
            set_progress(index, platform, 0);
            var on_progress = function(percentage) {
                set_progress(index, platform, percentage);
            };
            return take_screenshot(on_progress).then(function (screenshot) {
                var screenshot_set;
                if (index === null) {
                    screenshot_set = new ScreenshotSet({_changed: true});
                    screenshot_set.files[platform] = screenshot;
                    screenshots.push(screenshot_set);
                }
                else {
                    screenshot_set = screenshots[index];
                    screenshot.id = (screenshot_set.files[platform] ? screenshot_set.files[platform].id : null);
                    screenshot_set.files[platform] = screenshot;
                }
                self.trigger('changed', screenshots);
            }.bind(this)).catch(function (error) {
                self.trigger('error', {message: error.toString(), errorFor: gettext("take screenshot")});
            }.bind(this)).always(function () {
                clear_progress(index, platform);
                set_disabled(false);
            });
        };

        /**
         * ScreenshotsModel stores the currently uploaded screenshots
         * @constructor
         */
        this.loadScreenshots = function() {
            var timeout = setTimeout(function() {
                self.trigger('waiting');
            }, 500);
            return API.getScreenshots(test_id).then(function(result) {
                screenshots = result;
                original_screenshots = _.map(result, _.clone);
                self.trigger('changed', result);
            }).catch(function(error) {
                self.trigger('error', {message: error.message, errorfor: gettext('get screenshots')});
            }).finally(function() {
                clearTimeout(timeout);
            });
        };

        this.deleteFile = function(index, platform) {
            if (disabled) return;
            if (_.isObject(screenshots[index].files[platform])) {
                screenshots[index].files[platform] = {is_new: true};
                this.trigger('changed', screenshots);
            }
        };

        this.setName = function(index, name) {
            if (disabled) return;
            if (_.isString(name)) {
                var changed = (!(_.has(original_screenshots, index)) || (name != original_screenshots[index].name));
                screenshots[index].name = name;
                screenshots[index]._changed = changed;
                self.trigger('changed', screenshots);
            }
        };

        this.save = function() {
            if (disabled) return;
            set_disabled(true);
            var timeout = setTimeout(function() {
                self.trigger('waiting');
            }, 500);
            return API.saveScreenshots(test_id, screenshots).then(function(result) {
                self.trigger('saved', true);
                return self.loadScreenshots();
            }).catch(function(error) {
                self.trigger('error', {message: error.message, errorFor: gettext('save screenshots')});
            }).finally(function() {
                set_disabled(false);
                clearTimeout(timeout);
            });
        };
    }

    /** This class keeps track of which platform is currently selected, and also
     * interacts with the SidePane */
    function UIState(pane) {
        // TODO: fetch this from somewhere more global
        var supported_platforms = ['aplite', 'basalt', 'chalk'];
        var single = false;
        _.extend(this, Backbone.Events);
        this.toggle = function(platform) {
            single = (single ? false : platform);
            this.update();
        };

        this.update = function() {
            var platforms = (single ? [single] : supported_platforms);
            this.trigger('changed', {
                platforms: platforms
            });
            // When the user clicks a platform title, this causes the SidePane to resize appropriately.
            $(pane).innerWidth(this.getSize());
            pane.trigger('resize', this.getSize());
        };

        this.initial = function() {
            return _.clone(supported_platforms);
        };

        this.updateSupportedPlatforms = function() {
            return CloudPebble.Compile.GetPlatformsCompiledFor().then(function(platforms) {
                if (platforms.length > 0) {
                    supported_platforms = platforms;
                    // Sorting platforms alphabetically is practically *and* technically correct
                    platforms.sort();
                }
                this.update();
            }.bind(this));

        };

        this.getSize = function() {
            var platforms = (single ? [single] : supported_platforms);
            return (30+platforms.length*200)+"px";
        };
        // Set the initial size of the side pane.
        $(pane).width(this.getSize());
    }


    /**
     * This sets up a screenshot editor pane
     * @param test_id ID of test for this ScreenshotPane
     * @constructor
     */
    function ScreenshotPane(test_id) {
        var pane = $('<div>').toggleClass('monkey-pane');
        var uiState, screenshots, view;

        _.extend(this, Backbone.Events);
        // Set up the data/models and pass them to the UI.
        uiState = new UIState(pane);
        screenshots = new ScreenshotsModel(test_id);

        $.when(screenshots.loadScreenshots(), uiState.updateSupportedPlatforms()).then(function() {
            view = CloudPebble.MonkeyScreenshots.Interface(screenshots, uiState);
            view.render(pane.get()[0], {test_id: test_id});
        });

        /** Get the actual pane so it can be attached to an object */
        this.getPane = function() {
            return pane;
        };

        pane.on('restored', function() {
            // This is triggered by the SidePane holder whenever the pane is restored
            screenshots.loadScreenshots();
            uiState.updateSupportedPlatforms();
        });

        /** Destroy the contents of the pane */
        this.destroy = function() {
            pane.trigger('destroy');
            pane.empty();
            view = pane = screenshots = uiState = null;
        };

        this.getScreenshots = function() {
            return screenshots.getScreenshots();
        }
    }

    return {
        ScreenshotPane: ScreenshotPane
    }
})();