// Copyright 2016, EMC, Inc.
'use strict';

var di = require('di');

module.exports = taskGraphFactory;
di.annotate(taskGraphFactory, new di.Provide('TaskGraph.TaskGraph'));
di.annotate(taskGraphFactory,
    new di.Inject(
        'Task.taskLibrary',
        'Task.Task',
        'TaskGraph.Store',
        'Task.Messenger',
        'Constants',
        'Assert',
        'uuid',
        'Promise',
        '_'
    )
);

function taskGraphFactory(
    taskLibrary,
    Task,
    store,
    taskMessenger,
    Constants,
    assert,
    uuid,
    Promise,
    _
) {
    var _db;
    var MongoClient = require('mongodb').MongoClient;
    var url = 'mongodb://localhost:27017/pxe';


    MongoClient.connect(url, function(err, db) {
        assert.equal(null, err);
        console.log('connected to mongo');
        _db=db
    })
    function TaskGraph(definition, context, domain) {
        this.definition = definition;
        if (this.definition.options && this.definition.options.instanceId) {
            this.instanceId = this.definition.options.instanceId;
        } else {
            this.instanceId = uuid.v4();
        }

        // Bool
        this.serviceGraph = this.definition.serviceGraph;
        this.context = context || {};
        this.context.graphId = this.instanceId;
        this.domain = domain || Constants.Task.DefaultDomain;
        this.name = this.definition.friendlyName;
        this.injectableName = this.definition.injectableName;

        this.tasks = {};

        // TODO: find instances of 'valid' elsewhere and replace from valid to Pending
        // TODO: replace _status with status
        this._status = Constants.Task.States.Pending;

        this.logContext = {
            graphInstance: this.instanceId,
            graphName: this.name
        };
        if (this.context.target) {
            this.logContext.id = this.context.target;
        }
        // For database ref linking
        this.node = this.context.target || this.definition.options.nodeId;

        return this;
    }

    TaskGraph.prototype._visitGraphNode = function(
            taskId, parentTaskName, markers, nonTerminalOnStates) {
        var self = this;
        var task = self.tasks[taskId];
        var marker = markers[taskId];
        if (!marker) {
            marker = {};
            markers[taskId] = marker;
        }

        if (marker.temporaryMark) {
            throw new Error('Detected a cyclic graph with tasks %s and %s'.format(
                                task.injectableName, parentTaskName));
        }

        // Only check for task.terminalOnStates being null here, not for an empty array!
        var _terminalOnStates = task.terminalOnStates || Constants.Task.FinishedStates;
        task.terminalOnStates = _.difference(_terminalOnStates, nonTerminalOnStates);

        if (marker.permanentMark) {
            return;
        }

        marker.temporaryMark = true;

        _.forEach(task.waitingOn, function(value, dep) {
            var nonTerminalOnStates = [];

            // This won't actually get called because we do this same check in
            // _populateTaskData, but keep this here just to be defensive.
            if (!_.has(self.tasks, dep)) {
                throw new Error('Graph does not contain task with ID ' + dep);
            }
            // Expand 'finished' to all finished task states
            if (_.contains(value, Constants.Task.States.Finished)) {
                value = Constants.Task.FinishedStates;
                task.waitingOn[dep] = [Constants.Task.States.Finished];
            }
            // The dependent task is no longer terminal on state <value> since the
            // current task lists that condition as a dependency.
            // task.nonTerminalOnStates gets substracted from task.terminalOnStates
            // when we traverse to the dependent task.
            nonTerminalOnStates = Array.isArray(value) ? value : [value];
            return self._visitGraphNode(dep, task.injectableName, markers, nonTerminalOnStates);
        });

        marker.permanentMark = true;
        marker.temporaryMark = false;
    };

    TaskGraph.prototype.detectCyclesAndSetTerminalTasks = function() {
        var self = this;
        var markers = {};
        _.forEach(self.tasks, function(task, taskId) {
            self._visitGraphNode(taskId, null, markers, null);
        });
    };

    /*
     * Take the tasks definitions in this.definition.tasks, generate instanceIds
     * to use for each task, and then create new Task objects that reference
     * the instanceIds in their dependencies instead of user-created task labels.
     */
    // TODO: Replace this with a proper DFS traversal instead of iterating
    TaskGraph.prototype._populateTaskData = function() {
        var self = this;

        assert.arrayOfObject(self.definition.tasks);
        var idMap = _.transform(self.definition.tasks, function(result, v) {
            result[v.label] = uuid.v4();
        }, {});
        return Promise.map(self.definition.tasks, function(taskData) {
            assert.object(taskData);
            if (_.has(taskData, 'taskName')) {
                assert.string(taskData.taskName);
            } else if (_.has(taskData, 'taskDefinition')) {
                assert.object(taskData.taskDefinition);
            } else {
                throw new Error("All TaskGraph tasks should have either a taskName" +
                    " or taskDefinition property.");
            }

            _.forEach(_.keys(taskData.waitOn), function(waitOnTask) {
                var newWaitOnTaskKey = idMap[waitOnTask];
                assert.ok(newWaitOnTaskKey, 'Task to wait on does not exist: ' + waitOnTask);
                var waitOnTaskValue = taskData.waitOn[waitOnTask];
                delete taskData.waitOn[waitOnTask];
                taskData.waitOn[newWaitOnTaskKey] = waitOnTaskValue;
            });
            var taskOverrides = {
                instanceId: idMap[taskData.label],
                waitingOn: taskData.waitOn,
                ignoreFailure: taskData.ignoreFailure
            };

            if (taskData.taskName) {
                return self.constructTaskObject(
                    taskData.taskName,
                    taskOverrides,
                    taskData.optionOverrides,
                    taskData.label
                )
                .then(function(definition) {
                    self.tasks[definition.instanceId] = definition;
                });
            } else if (taskData.taskDefinition) {
                var definition = self.constructInlineTaskObject(taskData.taskDefinition,
                    taskOverrides, taskData.optionOverrides, taskData.label);
                self.tasks[definition.instanceId] = definition;
            }
        })
        .spread(function() {
            return self;
        });
    };

    TaskGraph.prototype.constructInlineTaskObject = function(_definition, taskOverrides,
           optionOverrides, label) {

        return this._buildTaskDefinition(_definition, optionOverrides,
                taskOverrides, label);
    };

    TaskGraph.prototype.constructTaskObject = function(taskName, taskOverrides,
           optionOverrides, label) {
        var self = this;
        return store.getTaskDefinition(taskName)
        .then(function(taskDefinition) {
            return self._buildTaskDefinition(
                taskDefinition,
                optionOverrides,
                taskOverrides,
                label
            );
        });
    };

    TaskGraph.prototype._buildTaskDefinition = function(_definition, optionOverrides,
            taskOverrides, label) {
        var self = this;
        var definition = _.cloneDeep(_definition);

        var baseTaskDefinition = self._getBaseTask(_definition);
        definition.instanceId = taskOverrides.instanceId;
        definition.properties = _.merge(definition.properties, baseTaskDefinition.properties);
        definition.runJob = baseTaskDefinition.runJob;
        definition.options = _.merge(definition.options || {}, optionOverrides || {});
        definition.label = label;
        definition.name = taskOverrides.name || definition.injectableName;
        definition.waitingOn = taskOverrides.waitingOn || {};
        // TODO: Remove ignoreFailure in favor of better graph branching evalution.
        // NOTE: actually ignoreFailure is still useful for tasks that can
        // fail but we don't care AND don't have anything queued up to run
        // on failure (rare case probably, but still worth supporting IMO).
        definition.ignoreFailure = taskOverrides.ignoreFailure || false;

        // If there is JSON schema defined for the task, then pass all task-specified option and
        // defaults options to the task, let the schema to determine whether the additional options
        // is allowed or not.
        if (definition.hasOwnProperty('schemaRef')) {
            if (!_.isEmpty(self.definition.options)) {
                //first scan 'defaults' then task-specific, so the task-specific option will take
                //precedent
                _.forEach(self.definition.options.defaults, function(optionValue, optionName) {
                    definition.options[optionName] = optionValue;
                });

                _.forEach(self.definition.options[label], function(optionValue, optionName) {
                    //if the null value in the task-specific option but a non-null value in
                    //defaults, then we will pick the non-null value, as the null value may only
                    //be a placeholder in task graph definition to indicate that this value is a
                    //required option.
                    if (optionValue !== null || definition.options[optionName] === null) {
                        definition.options[optionName] = optionValue;
                    }
                });
            }
        }
        else { //TODO: Remove this after task schema is full ready
            var allOptions = _.uniq(
                _.keys(definition.options).concat(baseTaskDefinition.requiredOptions)
            );

            // If the graph has specifically defined options for a task, don't bother
            // with whether they exist as a required option or not in the base definition.
            if (_.has(self.definition.options, label)) {
                allOptions = allOptions.concat(_.keys(self.definition.options[label]));
            }

            if (!_.isEmpty(self.definition.options)) {
                _.forEach(allOptions, function(option) {
                    var taskSpecificOptions = self.definition.options[label];
                    if (_.has(taskSpecificOptions, option)) {
                        definition.options[option] = taskSpecificOptions[option];
                    } else if (_.has(self.definition.options.defaults, option)) {
                        definition.options[option] = self.definition.options.defaults[option];
                    }
                });
            }
        }

        definition.state = Constants.Task.States.Pending;

        return definition;
    };

    /**
     * Attempt to create task objects for all tasks. Effectively this means
     * we are exercising the task definition rendering functionality for all
     * tasks with the information we have at this point in time, and so doing as much
     * up front validation as we can.
     */
    TaskGraph.prototype.renderTasks = function() {
        var self = this;
        return Promise.map(_.values(self.tasks), function(taskDefinition) {
            return Task.create(
                taskDefinition,
                { compileOnly: true, instanceId: taskDefinition.instanceId },
                self.context
            )
            .then(function(task) {
                // Overwrite definition options with the rendered options from
                // the task object
                self.tasks[taskDefinition.instanceId].options = task.options;
            });
        })
        .then(function() {
            return self;
        });
    };
    var store_getTaskDefinitionAVG =0
    var store_getTaskDefinitionARR = []
    TaskGraph.prototype.validate = function () {

        var start
        var self = this;
        var context = {};

        return Promise.resolve()
        .then(function() {
            // TODO: Move this into the loop below so we don't iterate more than
            // necessary.
            self._validateTaskLabels();
        })
        .then(function() {
            assert.arrayOfObject(self.definition.tasks, 'Graph.tasks');
            return Promise.map(self.definition.tasks, function(taskData) {
                if (!_.has(taskData, 'taskDefinition')) {
                    console.time("store_getTaskDefinition")
                    start = new Date().getTime()
                        //return store.getTaskDefinition(taskData.taskName)
                    return store.getTaskDefinition1(taskData.taskName)
                    .tap(console.timeEnd.bind(console, 'store_getTaskDefinition'))
                    .tap( function(){
                        var end = new Date().getTime()
                        var e = end-start
                        var sum = 0
                        store_getTaskDefinitionARR.push(e)
                        if(store_getTaskDefinitionARR.length === 4000) {
                            store_getTaskDefinitionARR.forEach(function (item) {
                                sum = sum + item
                            })
                            //console.log("sum on crearteAndRun", sum)
                            store_getTaskDefinitionAVG = sum / store_getTaskDefinitionARR.length
                            console.log("time_array of store_gstore_getTaskDefinition: " + store_getTaskDefinitionARR)
                            console.log("time_avg of store_getTaskDefinition: " + store_getTaskDefinitionAVG)
                        }
                        })
                    .then(function(definition) {
                        return {
                            taskDefinition: definition,
                            label: taskData.label
                        };
                    });
                } else {
                    return {
                        taskDefinition: taskData.taskDefinition,
                        label: taskData.label
                    };
                }
            })
            .then(function(tasks) {
                _.forEach(tasks, function(taskData) {
                    self._validateTaskDefinition(taskData.taskDefinition);
                    self._validateProperties(taskData.taskDefinition, context);
                    self._validateOptions(taskData.taskDefinition, taskData.label);
                });
            });
        })
        .then(function() {
            return self;
        });
    };

    TaskGraph.prototype._validateTaskLabels = function() {
        _.transform(this.definition.tasks, function(result, task) {
            if (result[task.label]) {
                throw new Error(("The task label '%s' is used more than once in " +
                                "the graph definition.").format(task.label));
            } else {
                result[task.label] = true;
            }
        }, {});
    };

    TaskGraph.prototype._validateTaskDefinition = function(taskDefinition) {
        assert.object(taskDefinition, 'taskDefinition');
        assert.string(taskDefinition.friendlyName, 'friendlyName');
        assert.string(taskDefinition.injectableName, 'injectableName');
        assert.string(taskDefinition.implementsTask, 'implementsTask');
        assert.object(taskDefinition.options, 'options');
        assert.object(taskDefinition.properties, 'properties');

        var baseTaskDefinition = this._getBaseTask(taskDefinition);
        assert.string(baseTaskDefinition.friendlyName, 'friendlyName');
        assert.string(baseTaskDefinition.injectableName, 'injectableName');
        assert.string(baseTaskDefinition.runJob, 'runJob');
        assert.object(baseTaskDefinition.requiredOptions, 'requiredOptions');
        assert.object(baseTaskDefinition.requiredProperties, 'requiredProperties');
        assert.object(baseTaskDefinition.properties, 'properties');
    };

    TaskGraph.prototype._validateProperties = function(taskDefinition, context) {
        var self = this;
        var baseTaskDefinition = self._getBaseTask(taskDefinition);
        var requiredProperties = baseTaskDefinition.requiredProperties;
        _.forEach(requiredProperties, function(v, k) {
            self.compareNestedProperties(
                v, k, context.properties, baseTaskDefinition.injectableName);
        });

        // Update shared context with properties from this task
        var _properties = _.merge(taskDefinition.properties, baseTaskDefinition.properties);
        context.properties = _.merge(_properties, context.properties);
    };

    TaskGraph.prototype._validateOptions = function(taskDefinition, label) {
        var self = this;
        var baseTaskDefinition = self._getBaseTask(taskDefinition);
        _.forEach(baseTaskDefinition.requiredOptions, function(k) {
            var option = taskDefinition.options[k];
            if (!option && _.has(self.definition.options.defaults, k)) {
                option = self.definition.options.defaults[k];
            }
            if (label && _.has(self.definition.options[label], k)) {
                option = self.definition.options[label][k];
            }
            assert.ok((option != null), // jshint ignore:line
                'required option ' + k + ' for task ' +
                taskDefinition.injectableName + ' in graph ' + self.injectableName);
        });
    };

    TaskGraph.prototype._getBaseTask = function(definition) {
        assert.object(definition);
        assert.string(definition.implementsTask);

        // TODO: this is just a temporary solution until base tasks are refactored
        // to be attributes of the job classes themselves.
        // TODO: also un-promisify all _getBaseTask calls *again* :(
        var baseTaskDefinition = _.find(taskLibrary, function(task) {
            return !task.implementsTask && task.injectableName === definition.implementsTask;
        });
        assert.object(baseTaskDefinition, "Base task definition for " +
                definition.implementsTask + " should exist");
        return baseTaskDefinition;
    };

    TaskGraph.prototype.compareNestedProperties = function(value, nestedKey, obj, taskName) {
        var self = this;

        // nested key is a dot notated string that represents a JSON scope, e.g.
        // os.linux.type represents { os: { linux: { type: 'value' } } }
        if (!nestedKey) {
            return;
        }
        assert.string(nestedKey);
        var keys = nestedKey.split('.');
        if (keys.length === 1) {
            assert.ok(_.has(obj, keys[0]),
                'expected property [' + keys[0] + '] to be supplied for task ' +
                taskName + ' in graph ' + self.injectableName);
            assert.equal(obj[keys[0]], value);
            return;
        }

        // Accumulator is a progressively nesting scope into an object, e.g.
        // 1. accumulator = key1  <- reduce makes accumulator the first item, which is a string
        // 2. accumulator = obj.key1.key2.key3  <- now accumulator is the object we returned
        // 3. accumulator = obj.key1.key2.key3.key4
        _.reduce(keys, function(accumulator, key) {
            var nested;

            if (typeof accumulator === 'string') {
                // First pass, accumulator is key[0]
                assert.ok(_.has(obj, accumulator),
                    'expected property [' + accumulator + '] to be supplied for task ' +
                    taskName + ' in graph ' + self.injectableName);
                nested = obj[accumulator];
            } else {
                // Subsequent passes, accumulator is an object
                assert.ok(_.has(accumulator, key),
                    'expected property [' + key + '] to be supplied for task ' +
                    taskName + ' in graph ' + self.injectableName);
                nested = accumulator;
            }

            // Last pass, check against the value now that we've reached
            // the correct scope.
            if (key === _.last(keys)) {
                assert.equal(nested[key], value,
                    'expected property [' + key + '] to equal ' + value + ' for task ' +
                    taskName + ' in graph ' + self.injectableName);
            }

            // Return next nested scope
            return nested[key];
        });
    };

    TaskGraph.prototype.createTaskDependencyObject = function(task) {
        return _.transform(task.waitingOn, function(out, states, taskId) {
            var first = true;
            var slicePosition = out.length || 1;
            states = Array.isArray(states) ? states : [states];
            states.forEach(function(state) {
                if (!out.length) {
                    var depObj = {};
                    depObj[taskId] = state;
                    out.push(depObj);
                } else if (first) {
                    out.forEach(function(item) {
                        item[taskId] = state;
                    });
                } else {
                    // Ensure each dependency object represents a unique
                    // dependency path iteration, accounting for all
                    // possible dependency paths.
                    // For example, if state === ['a', 'b'] then one dependency object
                    // will only include state 'a', and the other only state 'b'.
                    // This works with any number of items in any number of dependencies,
                    // and the number of unique dependency objects created is multiplicative.
                    var sliced = out.slice(out.length - slicePosition, out.length);
                    sliced.forEach(function(item) {
                        var dep = _.transform(item, function(result, v, k) {
                            result[k] = k === taskId ? state : v;
                        }, {});
                        out.push(dep);
                    });

                }
                if (first) {
                    first = false;
                }
            });
        }, []);
    };

    TaskGraph.prototype.createTaskDependencyItems = function() {
        var self = this;
        return _.flatten(_.map(this.tasks, function(task) {
            if (_.isEmpty(task.waitingOn)) {
                return {
                    taskId: task.instanceId,
                    dependencies: {},
                    terminalOnStates: task.terminalOnStates,
                    ignoreFailure: task.ignoreFailure
                };
            }
            return _.map(self.createTaskDependencyObject(task), function(dependencies) {
                return {
                    taskId: task.instanceId,
                    dependencies: dependencies,
                    terminalOnStates: task.terminalOnStates,
                    ignoreFailure: task.ignoreFailure
                };
            });
        }));
    };

    /**
     * Update tasks dependencies and graph object progress data, send progress AMQP message
     * @param {Object} an object of progress data that should include graphId and progress data
     * @returns {Promise}
     */ 
    TaskGraph.updateGraphProgress = function(progressData) {
        var pattern = /(100|\d{1,2})(\.\d{0,})?\%/;
        assert.uuid(progressData.graphId, "Progress data should include graphId");
        assert.object(progressData.progress, "Progress data should include progress data");
        if (_.has(progressData, 'progress.percentage')) {
            if (!progressData.progress.percentage ||
                !progressData.progress.percentage.match(pattern)) {
                progressData.progress.percentage = "Not Available";
            }
        }
        if (_.has(progressData, 'taskProgress.progress.percentage')) {
            if (!progressData.taskProgress.progress.percentage ||
                !progressData.taskProgress.progress.percentage.match(pattern)) {
                progressData.taskProgress.progress.percentage = "Not Available";
            }
        }
        return store.updateGraphProgress(progressData)
        .tap(function(){
            //For graph start and finished, no task progress data is include
            //task progress update is not necessary in these two cases
            if (_.has(progressData, 'taskProgress') &&
                !_.isEmpty(progressData.taskProgress)) {
                return store.updateTaskProgress(progressData.taskProgress);
            }
        })
        .then(function(_progressData){
            if (_.has(_progressData, "taskProgress.graphId")) {
                _progressData = _.omit(_progressData, "taskProgress.graphId");
            }
            return taskMessenger.publishProgressEvent(_progressData);
        });
    };

    // enables JSON.stringify(this)
    TaskGraph.prototype.toJSON = function toJSON() {
        return this;
    };

    var graphobjectsArr = []
    var graphobjectsArr = []
    var taskdependenciesArr = []
    var timer1
    
    // No waterline with Timer Based Queueing
    TaskGraph.prototype.persist2 = function() {
        var self = this;
        var timer1 ;
        var graphDone = false
        var taskDone = false

        var items= this.createTaskDependencyItems()

        var t = {
            "state" : "pending",
            "domain" : "default",
            "evaluated" : false,
            "reachable" : true,
            "taskRunnerLease" : null,
            "taskRunnerHeartbeat" : null,
            "context" : null
        }
        _.forEach(items,function(i, index){
            i  = store.persistTaskDependencies1(i, self.instanceId)
            i = _.merge(i,t)
            var r
            items[index]  = i
        })
        taskdependenciesArr.push(items)
        taskdependenciesArr=  _.flatten(taskdependenciesArr)


        return new Promise(function(resolve, reject){
            self["resolver"]=resolve
            self["rejecter"]=reject
            graphobjectsArr.push(self)
            var r= store.persistGraphObject1(self)
            console.log("x1x: graph after2: ")
            console.log(JSON.stringify(self, null, 4) )

            if((timer1 === undefined || timer1._called === true)){
                timer1 = setTimeout(function () {
                    console.log("in timer")
                    if(taskdependenciesArr.length >  0 ){
                    var graphobjectsArr1 = _.merge([], graphobjectsArr)
                    var taskdependenciesArr1 = _.merge([], taskdependenciesArr)
                    graphobjectsArr = []
                    taskdependenciesArr = []

                    console.log('inserted1, taskdependenciesArr:' + taskdependenciesArr1.length);
                    _db.collection('taskdependencies').insertMany(taskdependenciesArr1, function (err, r) {

                        taskDone = true
                        if (graphDone && taskDone) {
                            graphobjectsArr1.forEach(function (item) {
                                var reducedItem = _.merge({}, item)
                                delete reducedItem.resolver
                                delete reducedItem.rejecter
                                store.publishGraphRecord(reducedItem)
                                item.resolver(reducedItem)
                            })
                        }
                    })
                    _db.collection('graphobjects').insertMany(graphobjectsArr1, function (err, r) {
                        console.log('inserted1, graphobjectsArr1:' + graphobjectsArr1.length);
                        graphDone = true
                        if (graphDone && taskDone) {
                            graphobjectsArr1.forEach(function (item) {
                                var reducedItem = _.merge({}, item)
                                delete reducedItem.resolver
                                delete reducedItem.rejecter
                                store.publishGraphRecord(reducedItem)
                                item.resolver(reducedItem)
                            })
                        }
                    })
                }

                }, 10)
            }
        })
    }

    //No waterline but without queueing
    TaskGraph.prototype.persist1 = function() {
        var self = this;
        var items= this.createTaskDependencyItems()
        var t = {
            "state" : "pending",
            "domain" : "default",
            "evaluated" : false,
            "reachable" : true,
            "taskRunnerLease" : null,
            "taskRunnerHeartbeat" : null,
            "context" : null
        }

        return Promise.all(
            _.flatten([
                _db.collection('graphobjects').insert(self, function (err, r) {return 1}),
                this.createTaskDependencyItems().map(function(item) {
                    item  = store.persistTaskDependencies1(item, self.instanceId)
                    item = _.merge(item,t)
                    return _db.collection('taskdependencies').insert(item, function (err, r) { store.publishGraphRecord(self);})
                })
            ])
            )
            .then(function() {
                return self;
            });
    };    
    
    //original persit
    TaskGraph.prototype.persist = function() {
        var self = this;

        return Promise.all(
            _.flatten([
                store.persistGraphObject(self),
                this.createTaskDependencyItems().map(function(item) {
                    return store.persistTaskDependencies(item, self.instanceId)
                        .then(function () {
                            store.publishGraphRecord(self);
                        });
                })
            ])
        )
        .then(function() {
            return self;
        });
    };

    TaskGraph.create = function create(domain, data) {
        return TaskGraph.validateDefinition(domain, data)
        .then(function(graph) {
            return graph.renderTasks();
        });
    };
    var graph_populateTaskDataAVG =0
    var graph_populateTaskDataARR = []
    TaskGraph.validateDefinition = function validateDefinition(domain, data) {
        var definition = data.definition;
        var options = data.options;
        var context = data.context;
        var start
        var _definition = _.cloneDeep(definition);
        _definition.options = _.merge(definition.options || {}, options || {});

        return Promise.resolve()
        .then(function() {
            var graph = new TaskGraph(_definition, context, domain);
            return graph.validate();
        })
        .then(function(graph) {
            console.time("graph_populateTaskData")
            start = new Date().getTime()
            return graph._populateTaskData();
        })
            .tap( console.timeEnd.bind(console,'graph_populateTaskData'))
        .tap(function(graph) {
            graph.detectCyclesAndSetTerminalTasks();
        })
            .tap(function(){

                var end = new Date().getTime()
                var e = end-start
                var sum = 0
                graph_populateTaskDataARR.push(e)
                //console.log("graph_populateTaskDataARR "+ graph_populateTaskDataARR)
                if(graph_populateTaskDataARR.length ==  100) { // <<<<<<<<<<<<<<<<<<<<<
                    graph_populateTaskDataARR.forEach(function (item) {
                        sum = sum + item
                    })
                    graph_populateTaskDataAVG = sum / graph_populateTaskDataARR.length
                    console.log("time_array of graph_populateTaskDataARR: " + graph_populateTaskDataARR)
                    console.log("time_avg of graph_populateTaskDataAVG: " + graph_populateTaskDataAVG)
                }
            })
        .tap(function(graph) {
            return Promise.map(_.values(graph.tasks), function(taskDefinition) {
                return Task.validateDefinition(taskDefinition);
            });
        });
    };

    return TaskGraph;
}
