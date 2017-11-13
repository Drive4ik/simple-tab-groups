(function() {
    'use strict';

    storage.get({
            closePopupAfterChangeGroup: true,
        })
        .then(function(result) {
            new Vue({
                el: '#simple-tab-groups-options',
                name: 'simple-tab-groups-options',
                data: {
                    options: result,
                },
                watch: {
                    'options.closePopupAfterChangeGroup': 'saveOptions',
                },
                methods: {
                    getMessage: browser.i18n.getMessage,
                    saveOptions() {
                        storage.set(JSON.parse(JSON.stringify(this.options)));
                    },
                },
            });
        });

})();
