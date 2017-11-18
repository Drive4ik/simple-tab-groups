(function() {
    'use strict';

    let $on = on.bind({});

    function saveOptions() {
        return storage.set({
            closePopupAfterChangeGroup: $('#closePopupAfterChangeGroup').checked,
            openGroupAfterChange: $('#openGroupAfterChange').checked,
        });
    }

    $on('change', '#closePopupAfterChangeGroup, #openGroupAfterChange', saveOptions);

    storage.get(defaultOptions)
        .then(function(result) {
            $('#closePopupAfterChangeGroup').checked = result.closePopupAfterChangeGroup;
            $('#openGroupAfterChange').checked = result.openGroupAfterChange;
        })
        .then(translatePage);

})();
