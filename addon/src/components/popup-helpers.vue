<script>

import popup from './popup.vue';

export default {
    props: ['prompt', 'confirm'],
    components: {popup},
};

</script>

<template>
    <div>
        <popup
            v-if="prompt"
            :title="prompt.title"
            @resolve="prompt.resolve(true)"
            @close-popup="prompt.resolve(false)"
            @show-popup="$refs.promptInput.focus(); $refs.promptInput.select()"
            :buttons="
                [{
                    event: 'resolve',
                    classList: 'is-success',
                    lang: 'ok',
                    focused: false,
                }, {
                    event: 'close-popup',
                    lang: 'cancel',
                }]
            ">
            <div class="control is-expanded">
                <input
                    v-model.trim="prompt.value"
                    type="text"
                    class="input"
                    ref="promptInput"
                    @keydown.stop
                    @keyup.stop
                    @keydown.enter="prompt.resolve(true)"
                    :maxlength="prompt.maxlength"
                    />
            </div>
        </popup>

        <popup
            v-else-if="confirm"
            :title="confirm.title"
            @resolve="confirm.resolve(true)"
            @close-popup="confirm.resolve(false)"
            :buttons="
                [{
                    event: 'resolve',
                    classList: confirm.classList,
                    lang: confirm.lang,
                    focused: true,
                }, {
                    event: 'close-popup',
                    lang: 'cancel',
                }]
            ">
            <span class="white-space-pre-line" v-text="confirm.text"></span>
        </popup>
    </div>
</template>
