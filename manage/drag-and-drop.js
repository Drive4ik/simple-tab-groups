// Drag and drop utils

let DragAndDrop = new function() {
    'use strict';

    let allOptions = [],
        draggedNode = null,
        $on = on.bind({}),
        _addClass = null,
        _removeClass = null;

    const defaultOptions = {
        selector: 'div',
        group: null,
        classNameDraggedElement: 'drag-moving',
        classNameOverElement: 'drag-over',
    };

    // function getEls(options) {
    //     return document.querySelectorAll(options.selector);
    // }

    function _prepareGroup(rawGroup) {
        let group = {
            name: Date.now(),
            put: [],
        };

        if ('string' === type(rawGroup)) {
            group.name = rawGroup;
        } else if ('object' === type(rawGroup)) {
            Object.assign(group, rawGroup);
        }

        return group;
    }

    this.create = function(options) {
        let preparedOptions = Object.assign({}, defaultOptions, options);

        preparedOptions.group = _prepareGroup(preparedOptions.group);

        // console.log('options', options);
        // console.log('preparedOptions', preparedOptions);
        allOptions.push(preparedOptions);

        // $on('mousedown mouseup', options.selector, );

        // let elements = Array.from(document.querySelectorAll(options.selector));

        document.querySelectorAll(preparedOptions.selector).forEach(function(element) {
            element.options = preparedOptions;
            element.addEventListener('dragstart', dragStart, false);
            element.addEventListener('dragenter', dragEnter, false);
            element.addEventListener('dragover', dragOver, false);
            element.addEventListener('dragleave', dragLeave, false);
            element.addEventListener('drop', drop, false);
            element.addEventListener('dragend', dragEnd, false);

            element.addEventListener('mousedown', onMouseDown, false);
            // element.addEventListener('mouseup', onMouseDownUp, false);
        });
    };

    function onMouseDown(event) {
        // let options = this.dnd;
        // console.log('onMouseDownUp', options, event);
        if (1 !== event.which) {
            return;
        }

        if (!event.target.matches || !event.target.matches(this.options.draggableElements)) {
            console.log('stop mouse down');
            // event.stopPropagation();
            return event.preventDefault();
        }

        // event.preventDefault();
        event.stopPropagation();

        // if (event.type === 'mousedown') {
        //     this.draggable = true;
        // } else if (event.type === 'mouseup') {
        //     this.removeAttribute('draggable');
        // }
    }

    let prevOverElement = null;

    function dragStart(event) {
        // let options = this.dnd;
        // console.log(options.group.name + ' - dragStart', this);

        this.classList.add(this.options.classNameDraggedElement);

        event.stopPropagation();

        // remove events from childs when drag enter
        setPointerEvents(this.options);

        draggedNode = this;

        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/html', this.innerHTML);
        // event.dataTransfer.setData('text', '');

        draggedNode.options.onStart && draggedNode.options.onStart(event);
    }

    function dragEnter(event) {
        if (this.options.group.name !== draggedNode.options.group.name && !this.options.group.put.includes(draggedNode.options.group.name)) {
            return;
        }

        event.stopPropagation();

        this.classList.add(this.options.classNameOverElement);
    }

    function dragLeave(event) {
        if (this.options.group.name !== draggedNode.options.group.name && !this.options.group.put.includes(draggedNode.options.group.name)) {
            return;
        }

        event.stopPropagation();

        this.classList.remove(this.options.classNameOverElement);
    }

    function dragOver(event) {
        if (this.options.group.name !== draggedNode.options.group.name && !this.options.group.put.includes(draggedNode.options.group.name)) {
            return;
        }

        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';

        return false;
    }

    function drop(event) {
        // let options = this.dnd;

        if (this.options.group.name !== draggedNode.options.group.name && !this.options.group.put.includes(draggedNode.options.group.name)) {
            return;
        }

        event.stopPropagation(); // stops the browser from redirecting.

        if (draggedNode != this) {
            console.log(this.options.group.name + ' - drop', event);
            // draggedNode.innerHTML = this.innerHTML;
            // this.innerHTML = event.dataTransfer.getData('text/html');

            draggedNode.options.onDrop && draggedNode.options.onDrop(event, draggedNode, this);
        }

        return false;
    }

    function dragEnd(event) {
        if (this.options.group.name !== draggedNode.options.group.name && !this.options.group.put.includes(draggedNode.options.group.name)) {
            return;
        }

        event.stopPropagation();

        removeClasses(draggedNode.options, this.options);

        setPointerEvents(this.options, false);

        draggedNode.options.onEnd && draggedNode.options.onEnd(event);

        draggedNode = null;
    }

    function setPointerEvents(options, setEvents = true) {
        document.querySelectorAll(options.selector)
            .forEach(node => Array.from(node.children).forEach(child => child.style.pointerEvents = (setEvents ? 'none' : '')));

        allOptions.forEach(function(opt) {
            if (opt.group.name !== options.group.name && opt.group.put.includes(options.group.name)) {
                document.querySelectorAll(opt.selector).forEach(function(node) {
                    Array.from(node.children).forEach(child => child.style.pointerEvents = (setEvents ? 'none' : ''));

                    node.querySelectorAll(`[data-draggable-group="${options.group.name}"]`).forEach(n => n.style.pointerEvents = (setEvents ? 'all' : ''));
                });
            }
        });
    }

    function removeClasses(firstOptions, secondOptions) {
        let classList = [firstOptions.classNameDraggedElement, firstOptions.classNameOverElement];

        if (!classList.includes(secondOptions.classNameDraggedElement)) {
            classList.push(secondOptions.classNameDraggedElement);
        }

        if (!classList.includes(secondOptions.classNameOverElement)) {
            classList.push(secondOptions.classNameOverElement);
        }

        document.querySelectorAll('.' + classList.join(', .')).forEach(element => element.classList.remove.apply(element.classList, classList));
    }





};
