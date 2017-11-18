(function() {
    'use strict';

    let $on = on.bind({});

    function saveOptions() {
        return storage.set({
            closePopupAfterChangeGroup: $('#closePopupAfterChangeGroup').checked,
            openGroupAfterChange: $('#openGroupAfterChange').checked,
            showGroupCircleInSearchedTab: $('#showGroupCircleInSearchedTab').checked,
            showUrlTooltipOnTabHover: $('#showUrlTooltipOnTabHover').checked,
        });
    }

    $on('change', '#closePopupAfterChangeGroup, #openGroupAfterChange, #showGroupCircleInSearchedTab, #showUrlTooltipOnTabHover', saveOptions);

    storage.get(defaultOptions)
        .then(function(result) {
            $('#closePopupAfterChangeGroup').checked = result.closePopupAfterChangeGroup;
            $('#openGroupAfterChange').checked = result.openGroupAfterChange;
            $('#showGroupCircleInSearchedTab').checked = result.showGroupCircleInSearchedTab;
            $('#showUrlTooltipOnTabHover').checked = result.showUrlTooltipOnTabHover;
        })
        .then(translatePage);

})();
